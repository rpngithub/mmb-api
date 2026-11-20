const os = require('os');
const { Op } = require('sequelize');
const queue        = require('./queue');
const routing      = require('./routing');
const providers    = require('./providers');
const credentialStore = require('./credentialStore');
const inputSchema  = require('./inputSchema');
const aiConfig     = require('../config/ai');
const { INTERNAL, isTerminal, ProviderError } = require('./errors');
const { STATUS } = queue;

// The AI dispatcher. One tick:
//
//   1. dispatch  — queued jobs out to providers, within each provider's rate budget
//                  and concurrency cap; sends run in the background (drain())
//   2. poll      — status checks for `processing` jobs no webhook has finished
//   3. sweep     — stuck sends become `unknown`, overdue jobs fail and refund,
//                  unknowns are resolved
//
// Only the holder of the `mmb_ai_worker` advisory lock runs ticks (see
// jobs/aiWorker.job.js), so the per-provider token buckets can live in this
// process's memory. Providers count status checks against the same limit as
// sends (Magnific: 50/min for the whole account), so polling draws from the same
// bucket. A new leader starts each bucket half full, so a leadership change can
// never burst a full minute's budget on top of what the old leader just spent.
//
// Correctness never depends on the lock: every move is a guarded transition
// (ai/queue.js), so two workers overlapping during a DB failover cannot send a
// job twice; at worst they overspend the rate budget briefly and meet a few 429s.

const INSTANCE = `${os.hostname()}:${process.pid}`;
const DISPATCH_BATCH   = 50;
const MAX_SEND_ATTEMPTS = 5;              // door refusals (429, 503 — before_send) per job before giving up
const POLL_AFTER_MS_WEBHOOK = 60 * 1000;  // a webhook is expected; check only if it is late
const POLL_AFTER_MS_NO_WEBHOOK = 3 * 1000;
const STUCK_FINALIZE_MS = 10 * 60 * 1000;
// How long a job that could not be sent this tick steps aside (B2).
const DEFER_NO_ROUTE_MS = 15 * 1000;
const DEFER_MIN_MS = 1000;
// About one rate-limit token at the fastest of these providers, so a job waiting
// for budget is looked at again roughly when budget is back.
const budgetDelayMs = (cands) => {
  const rpm = Math.max(...cands.map((c) => Number(c.provider.rate_limit_rpm) || 1), 1);
  return Math.min(Math.max(Math.ceil(60000 / rpm), DEFER_MIN_MS), DEFER_NO_ROUTE_MS);
};
// Failures that will repeat for every job until a human acts — see routing.trip.
const TRIPPING = new Set([INTERNAL.AUTH_FAILED, INTERNAL.PROVIDER_OUT_OF_CREDITS]);

// ---------------------------------------------------------------------------
// Rate budget
// ---------------------------------------------------------------------------

const buckets = new Map();   // provider id -> { tokens, last, rpm }

function bucketFor(provider, nowMs) {
  const rpm = Math.max(Number(provider.rate_limit_rpm) || 1, 1);
  let b = buckets.get(provider.id);
  if (!b || b.rpm !== rpm) {
    b = { tokens: rpm / 2, last: nowMs, rpm };
    buckets.set(provider.id, b);
  }
  b.tokens = Math.min(rpm, b.tokens + ((nowMs - b.last) * rpm) / 60000);
  b.last = nowMs;
  return b;
}

function takeToken(provider, nowMs) {
  const b = bucketFor(provider, nowMs);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Whether a token is there, without spending it — route choice asks about several
// providers before committing to one.
const peekToken = (provider, nowMs) => bucketFor(provider, nowMs).tokens >= 1;

const resetBuckets = () => buckets.clear();

// ---------------------------------------------------------------------------
// Sends in flight
// ---------------------------------------------------------------------------
//
// dispatch() STARTS sends and returns; it never waits for them. A synchronous
// provider (text generation, background removal) holds its HTTP call open for
// seconds, and waiting on it would stall polling and the sweep for every other
// job — and every other provider — behind the slowest call.
//
// `max_concurrency` therefore means: requests from us to that provider that have
// not finished yet, counted across ticks. A task an ASYNC provider accepted and is
// still working on is not counted — its submit returned; the provider's own
// limit is requests per minute, which the token bucket enforces.

const active  = new Map();   // provider id -> sends not yet finished
const running = new Set();   // their promises, for drain()

const activeFor = (providerId) => active.get(providerId) || 0;

function startSend(job, cand, now) {
  const id = cand.provider.id;
  active.set(id, activeFor(id) + 1);
  const p = send(job, cand, now)
    .catch((err) => console.error(`[AI] send ${job.uid} crashed: ${err.message}`))
    .finally(() => {
      const n = activeFor(id) - 1;
      if (n > 0) active.set(id, n); else active.delete(id);
      running.delete(p);
    });
  running.add(p);
  return p;
}

// Resolves once every send started so far has finished — before the leader gives
// up its lock, and in tests after a dispatch.
async function drain() {
  while (running.size) await Promise.all([...running]);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const backoffMs = (attempt, err) => err?.retryAfterMs || Math.min(2000 * 2 ** Math.max(attempt - 1, 0), 60000);

// Media uids -> URLs, for adapters that fetch inputs by URL. Resolved at send
// time, never stored.
//
// adapter.mediaUrlMode picks the kind of URL:
//   'presigned' (default)  a 15-minute presigned GET
//   'public'               cdn_base_url + s3_key — the same URL the app renders
//                          the file with. For providers that cannot fetch a
//                          presigned URL: Magnific answers "Failed to download
//                          the image." for one that a browser opens fine
//                          (2026-11-20), and fetches the plain object URL.
//                          Exposes nothing new: uploads are already served
//                          publicly at that URL, under unguessable uuid keys.
async function publicMediaBase() {
  const configSvc = require('../services/config.service');
  const base = String(await configSvc.getSetting('cdn_base_url', '') || '').replace(/\/+$/, '');
  // Our configuration, not the user's input: wait and fail as unavailable.
  if (!base) throw new ProviderError(INTERNAL.PROVIDER_DOWN, 'before_send', { detail: 'cdn_base_url is not set; this provider fetches inputs by public URL' });
  return base;
}

async function resolveMedia(job, operation, adapter) {
  const input = { ...(job.input || {}) };
  const refs = inputSchema.mediaRefs(operation.input_schema, input);
  if (!refs.length || !adapter.needsMediaUrls) return input;

  const { UserUpload } = require('../models');
  const s3 = require('../utils/s3Helper');
  const base = adapter.mediaUrlMode === 'public' ? await publicMediaBase() : null;
  const urlFor = (key) => (base
    ? `${base}/${String(key).split('/').map(encodeURIComponent).join('/')}`
    : s3.getPresignedUrl(key, 900));

  const rows = await UserUpload.findAll({ where: { user_id: job.user_id, uid: refs.map((r) => r.uid) } });
  const byUid = new Map(rows.map((r) => [r.uid, r]));
  const toRef = async (uid) => {
    const row = byUid.get(uid);
    if (!row) throw new ProviderError(INTERNAL.INVALID_INPUT, 'before_send', { detail: 'input image was deleted' });
    return { uid, url: await urlFor(row.s3_key), content_type: row.content_type, bytes: Number(row.bytes) };
  };
  for (const [k, def] of Object.entries(operation.input_schema?.fields || {})) {
    if (def.type === 'media' && input[k]) input[k] = await toRef(input[k]);
    if (def.type === 'media_list' && Array.isArray(input[k])) input[k] = await Promise.all(input[k].map(toRef));
  }
  return input;
}

// Images the server attaches from the job's context (the project thumbnail), for
// adapters that take inline images. Read at send time, never stored on the job.
// Best effort: a thumbnail since replaced or deleted just means a text-only prompt.
const MAX_ATTACHMENT_BYTES = 600 * 1024;   // thumbnails are capped at 500 KB on upload

async function resolveAttachments(job, adapter) {
  const list = job.context?.attachments;
  if (!adapter.acceptsInlineImages || !Array.isArray(list) || !list.length) return [];
  const s3 = require('../utils/s3Helper');
  const { sniff } = require('./resultStore');
  const out = [];
  for (const a of list) {
    try {
      const bytes = await s3.getObjectBuffer(a.s3_key, { maxBytes: MAX_ATTACHMENT_BYTES });
      const mime = sniff(bytes);
      if (!mime || mime === 'image/svg+xml') continue;
      out.push({ kind: a.kind, mime, base64: bytes.toString('base64') });
    } catch (err) {
      console.warn(`[AI] job ${job.uid}: attachment ${a.kind} skipped (${err.message})`);
    }
  }
  return out;
}

async function recordAttempt(job, route, provider, fields) {
  const { AiJobAttempt } = require('../models');
  return AiJobAttempt.create({
    job_id: job.id, attempt_no: job.attempts_count, route_id: route?.id || null,
    provider_id: provider?.id || null, model: route?.model || null, ...fields,
  });
}

async function send(job, cand, now) {
  const jobs = require('../services/aiJob.service');
  const { AiOperation } = require('../models');
  const { route, provider, adapter } = cand;

  // Snapshot what this attempt costs us, so margins stay right after a price change.
  const units = Number(route.provider_units || 0);
  const cpu   = provider.cost_per_unit_inr === null ? null : Number(provider.cost_per_unit_inr);
  // And what this attempt asked for: the route's fixed_params (prompts, output
  // schema) can be edited later, so the job keeps the version it was sent with.
  const fixed = route.fixed_params || {};
  await job.update({
    route_id: route.id, provider_id: provider.id, model: route.model,
    provider_units: units, cost_per_unit_inr: cpu, cost_inr: cpu === null ? null : units * cpu,
    request_snapshot: {
      route_id: route.id, model: route.model, prompt_version: fixed.prompt_version || null,
      fixed_params: fixed, sent_at: new Date().toISOString(),
    },
  });

  const started = Date.now();
  const attempt = await recordAttempt(job, route, provider, { started_at: new Date(started) });
  const capture = Boolean(provider.settings?.capture_responses);
  const finish = (fields, raw) => attempt.update({
    ...fields, finished_at: new Date(), duration_ms: Date.now() - started,
    ...(capture && raw ? { response_excerpt: raw } : {}),
  });

  try {
    const operation = await AiOperation.findByPk(job.operation_id);
    const input  = await resolveMedia(job, operation, adapter);
    const apiKey = adapter.requiresApiKey ? await credentialStore.apiKey(provider) : null;
    const base   = aiConfig.publicWebhookBase();
    const callbackUrl = base ? `${base}${aiConfig.API_PREFIX()}/webhooks/ai/${provider.key}` : null;

    const attachments = await resolveAttachments(job, adapter);
    const out = await adapter.submit({ input, route, provider, apiKey, callbackUrl, context: job.context || null, attachments });
    routing.recordSuccess(provider.id);

    if (out.kind === 'sync') {
      await finish({ outcome: 'done' }, out.raw);
      await job.update({ sent_at: new Date() });
      await jobs.completeJob(job, { files: out.files, text: out.text }, adapter, { from: STATUS.SENDING, providerUnits: out.providerUnits });
      return;
    }

    await finish({ outcome: 'accepted', provider_task_id: out.taskId }, out.raw);
    await queue.transition(job.id, STATUS.SENDING, {
      status: STATUS.PROCESSING, provider_task_id: out.taskId, sent_at: new Date(),
    });
  } catch (raw) {
    const err = adapter.normalizeError(raw);
    await finish({
      outcome: isTerminal(err.code) ? 'failed' : err.phase === 'before_send' ? 'requeued' : err.phase === 'after_send' ? 'unknown' : 'failed',
      http_status: err.httpStatus, error_code: err.code, error_detail: err.detail,
    }, err.responseExcerpt);

    // A bad key or an empty balance fails every job the same way: take the
    // provider out of rotation for a while instead of retrying into it.
    if (TRIPPING.has(err.code)) {
      routing.trip(provider.id, err.code === INTERNAL.AUTH_FAILED ? 'auth_failed' : 'out_of_credits');
    }
    // Refused at the door: evidence of an outage, counted towards the circuit.
    if (err.code === INTERNAL.PROVIDER_DOWN && err.phase === 'before_send') {
      routing.recordFailure(provider.id, Date.now());
    }

    if (isTerminal(err.code)) {
      await jobs.failJob(job, err.code, { from: STATUS.SENDING, detail: err.detail });
    } else if (err.phase === 'before_send') {
      // Counted as door refusals (this one included — its attempt row was just
      // marked `requeued`), not as claims: a task that later fails after starting
      // must not find its retry budget spent on 429s (B4).
      const { AiJobAttempt } = require('../models');
      const refusals = await AiJobAttempt.count({ where: { job_id: job.id, outcome: 'requeued' } });
      if (refusals >= MAX_SEND_ATTEMPTS) {
        await jobs.failJob(job, err.code, { from: STATUS.SENDING, detail: err.detail });
      } else {
        const delayMs = TRIPPING.has(err.code) ? routing.TRIP_MS : backoffMs(refusals, err);
        await queue.requeue(job, { now, delayMs });
      }
    } else if (err.phase === 'after_send') {
      // It may have started, and may be billed. Never resend: the sweep resolves it.
      await queue.markUnknown(job, { now });
    } else {
      await jobs.failJob(job, err.code, { from: STATUS.SENDING, detail: err.detail });
    }
  }
}

// Per job, from its earlier attempts:
//   exclude — routes where its task FAILED after starting; never sent there again
//   avoid   — the route its LAST attempt was refused at the door on (503, refused),
//             tried after any alternative
async function attemptHistory(jobIds) {
  const { AiJobAttempt } = require('../models');
  const out = new Map();
  if (!jobIds.length) return out;
  const rows = await AiJobAttempt.findAll({
    where: { job_id: jobIds }, attributes: ['job_id', 'attempt_no', 'route_id', 'outcome', 'error_code'],
    order: [['job_id', 'ASC'], ['attempt_no', 'ASC']],
  });
  for (const r of rows) {
    if (!out.has(r.job_id)) out.set(r.job_id, { exclude: new Set(), avoid: new Set(), last: null });
    const h = out.get(r.job_id);
    if (r.outcome === 'failed' && r.route_id) h.exclude.add(r.route_id);
    h.last = r;
  }
  for (const h of out.values()) {
    if (h.last && h.last.outcome === 'requeued' && h.last.error_code === INTERNAL.PROVIDER_DOWN && h.last.route_id) {
      h.avoid.add(h.last.route_id);
    }
  }
  return out;
}

async function dispatch(now, { rng = Math.random } = {}) {
  const jobs = require('../services/aiJob.service');
  const due = await queue.due(now, DISPATCH_BATCH);
  const s = await aiConfig.settings();
  const routesByOp = new Map();
  const history = await attemptHistory(due.filter((j) => j.attempts_count > 0).map((j) => j.id));
  let dispatched = 0;
  const reasons = {};

  const hasBudget = (c) => activeFor(c.provider.id) < Number(c.provider.max_concurrency || 1)
    && peekToken(c.provider, now.getTime());

  const deferrals = new Map();   // delay ms -> job ids
  const defer = (job, ms) => {
    if (!deferrals.has(ms)) deferrals.set(ms, []);
    deferrals.get(ms).push(job.id);
  };

  for (const job of due) {
    if (!job.user_id) {
      // The owner was purged while this waited. Nothing to deliver to, nobody to refund.
      await jobs.failJob(job, INTERNAL.UNKNOWN, { from: STATUS.QUEUED, detail: 'owner deleted' });
      continue;
    }
    if (!routesByOp.has(job.operation_id)) routesByOp.set(job.operation_id, await routing.candidates(job.operation_id));
    const cands = routesByOp.get(job.operation_id);
    if (!cands.length) {
      // No usable route now. It waits in the queue (an admin may be rotating a key)
      // until the job timeout fails and refunds it.
      defer(job, DEFER_NO_ROUTE_MS);
      continue;
    }

    const h = history.get(job.id) || { exclude: new Set(), avoid: new Set() };
    const { cand, reason } = routing.choose(cands, {
      nowMs: now.getTime(),
      waitedMs: now.getTime() - new Date(job.created_at).getTime(),
      spillAfterMs: s.ai_spillover_wait_seconds * 1000,
      excludeRouteIds: h.exclude, avoidRouteIds: h.avoid, hasBudget, rng,
    });
    reasons[reason] = (reasons[reason] || 0) + 1;
    if (!cand) {
      // Every route it could use has already failed it: nothing left to try.
      if (reason === 'no_route') await jobs.failJob(job, INTERNAL.NO_ROUTE, { from: STATUS.QUEUED, detail: 'no route left to try' });
      // Waiting on rate budget: back in about one token's time. Waiting on a
      // circuit, or on a primary it may not leave: back in a few seconds.
      else defer(job, reason === 'waiting_budget' || reason === 'waiting_fallback' ? budgetDelayMs(cands) : DEFER_NO_ROUTE_MS);
      continue;
    }
    if (!takeToken(cand.provider, now.getTime())) { defer(job, budgetDelayMs([cand])); continue; }

    const claimed = await queue.claim(job, { now, instance: INSTANCE });
    if (!claimed) continue;
    startSend(claimed, cand, now);
    dispatched += 1;
  }

  // B2: what could not go out this tick steps out of the head of the queue, so a
  // backlog of DISPATCH_BATCH jobs that cannot be sent (a provider out of budget,
  // an operation with no route) never hides the jobs behind it.
  for (const [ms, ids] of deferrals) await queue.defer(ids, new Date(now.getTime() + ms));

  // Not awaited — see "Sends in flight". The tick moves on to poll and sweep.
  return { dispatched, reasons, deferred: [...deferrals.values()].reduce((n, ids) => n + ids.length, 0) };
}

// ---------------------------------------------------------------------------
// Polling and the sweep
// ---------------------------------------------------------------------------

async function checkStatus(job, now) {
  const jobs = require('../services/aiJob.service');
  const { AiProvider, AiOperationRoute } = require('../models');
  const provider = await AiProvider.findByPk(job.provider_id);
  const adapter = provider && providers.get(provider.key);
  if (!adapter || !job.provider_task_id) return false;
  if (!takeToken(provider, now.getTime())) return false;

  const route = await AiOperationRoute.findByPk(job.route_id);
  await queue.transition(job.id, [STATUS.PROCESSING, STATUS.UNKNOWN], { last_status_check_at: now });
  const capture = async (raw) => {
    if (!raw || !provider.settings?.capture_responses) return;
    const { AiJobAttempt } = require('../models');
    await AiJobAttempt.update(
      { response_excerpt: `[status ${now.toISOString()}] ${raw}`.slice(0, 2000) },
      { where: { job_id: job.id, attempt_no: job.attempts_count } },
    );
  };
  try {
    const apiKey = adapter.requiresApiKey ? await credentialStore.apiKey(provider) : null;
    const update = await adapter.getStatus({ taskId: job.provider_task_id, route, provider, apiKey });
    await capture(update.raw);
    await jobs.applyProviderUpdate(job, update, adapter);
    return true;
  } catch (raw) {
    const err = adapter.normalizeError(raw);
    await capture(err.responseExcerpt);
    if (TRIPPING.has(err.code)) routing.trip(provider.id, err.code === INTERNAL.AUTH_FAILED ? 'auth_failed' : 'out_of_credits');
    console.warn(`[AI] status check ${job.uid}: ${err.code} ${err.detail || ''}`);
    return false;
  }
}

async function poll(now) {
  const { AiJob } = require('../models');
  const after = aiConfig.publicWebhookBase() ? POLL_AFTER_MS_WEBHOOK : POLL_AFTER_MS_NO_WEBHOOK;
  const cutoff = new Date(now.getTime() - after);
  const stuckFinalize = new Date(now.getTime() - STUCK_FINALIZE_MS);

  // A finalize that died mid-copy (process killed) is released for another try.
  await AiJob.update({ finalizing_at: null }, {
    where: { status: STATUS.PROCESSING, finalizing_at: { [Op.lt]: stuckFinalize } },
  });

  const jobs = await AiJob.findAll({
    where: {
      status: STATUS.PROCESSING,
      finalizing_at: null,
      [Op.or]: [
        { last_status_check_at: null, sent_at: { [Op.lte]: cutoff } },
        { last_status_check_at: { [Op.lte]: cutoff } },
      ],
    },
    order: [['id', 'ASC']],
    limit: DISPATCH_BATCH,
  });
  let checked = 0;
  for (const job of jobs) if (await checkStatus(job, now)) checked += 1;
  return { checked };
}

async function sweep(now) {
  const jobs = require('../services/aiJob.service');
  const { AiJob, AiProvider } = require('../models');
  const s = await aiConfig.settings();
  let swept = 0;

  // sending for longer than twice the provider's timeout: the sender died
  // mid-send. It may have reached the provider, so it becomes `unknown` — never
  // `queued`.
  const sending = await AiJob.findAll({ where: { status: STATUS.SENDING, claimed_at: { [Op.lt]: new Date(now.getTime() - 10 * 1000) } } });
  for (const job of sending) {
    const provider = job.provider_id ? await AiProvider.findByPk(job.provider_id) : null;
    const limitMs = 2 * Number(provider?.timeout_ms || 30000);
    if (now.getTime() - new Date(job.claimed_at).getTime() < limitMs) continue;
    if (await queue.markUnknown(job, { now })) swept += 1;
  }

  // unknown WITH a task id: the send succeeded and we crashed before saving
  // `processing`. It can be checked like any processing job.
  await AiJob.update({ status: STATUS.PROCESSING }, {
    where: { status: STATUS.UNKNOWN, provider_task_id: { [Op.ne]: null } },
  });

  // unknown WITHOUT a task id cannot be looked up. After the resolve window it
  // fails and refunds; the monthly invoice reconciliation catches what we paid.
  const unknownCutoff = new Date(now.getTime() - s.ai_unknown_resolve_minutes * 60 * 1000);
  const unknowns = await AiJob.findAll({
    where: { status: STATUS.UNKNOWN, provider_task_id: null, updated_at: { [Op.lte]: unknownCutoff } },
  });
  for (const job of unknowns) {
    if (await jobs.failJob(job, INTERNAL.TIMEOUT, { from: STATUS.UNKNOWN, detail: 'send outcome unknown' })) swept += 1;
  }

  // Overdue: one last status check, then fail and refund. Queued jobs that never
  // found a route count too.
  const overdueCutoff = new Date(now.getTime() - s.ai_job_timeout_minutes * 60 * 1000);
  const overdue = await AiJob.findAll({
    where: { status: [STATUS.PROCESSING, STATUS.QUEUED], created_at: { [Op.lte]: overdueCutoff }, finalizing_at: null },
    limit: DISPATCH_BATCH,
  });
  // A queued job that never went out timed out for one of two reasons (B5): no
  // route could take it (provider down / disabled — AI_UNAVAILABLE), or routes
  // existed and it only waited on rate budget, a circuit or retries — AI_TIMEOUT.
  const routable = new Map();   // operation id -> has an eligible route now
  const hasRoute = async (operationId) => {
    if (!routable.has(operationId)) routable.set(operationId, routing.eligible(await routing.candidates(operationId)).length > 0);
    return routable.get(operationId);
  };
  for (const job of overdue) {
    if (job.status === STATUS.PROCESSING) {
      await checkStatus(job, now);
      const fresh = await AiJob.findByPk(job.id);
      if (!fresh || fresh.status !== STATUS.PROCESSING || fresh.finalizing_at) continue;
    }
    const code = job.status === STATUS.QUEUED && !(await hasRoute(job.operation_id)) ? INTERNAL.NO_ROUTE : INTERNAL.TIMEOUT;
    if (await jobs.failJob(job, code, { from: job.status, detail: 'job timed out' })) swept += 1;
  }

  return { swept };
}

// The provider-balance estimate is a few aggregate queries — every 10 minutes is
// plenty for an alert that repeats at most daily.
const BALANCE_CHECK_EVERY_MS = 10 * 60 * 1000;
let lastBalanceCheck = 0;

async function tick({ now = new Date() } = {}) {
  const d = await dispatch(now);
  const p = await poll(now);
  const s = await sweep(now);
  if (now.getTime() - lastBalanceCheck >= BALANCE_CHECK_EVERY_MS) {
    lastBalanceCheck = now.getTime();
    try { await require('./balance').checkAndAlert(now); } catch (err) {
      console.error(`[AI] balance check failed: ${err.message}`);
    }
  }
  return { ...d, ...p, ...s };
}

module.exports = {
  tick, dispatch, poll, sweep, send, drain, activeFor, takeToken, peekToken, bucketFor, resetBuckets, INSTANCE, MAX_SEND_ATTEMPTS,
};
