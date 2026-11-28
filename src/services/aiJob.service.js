const crypto = require('crypto');
const { Op, UniqueConstraintError } = require('sequelize');
const quota        = require('./quota.service');
const configSvc    = require('./config.service');
const aiConfig     = require('../config/ai');
const queue        = require('../ai/queue');
const routing      = require('../ai/routing');
const pricing      = require('../ai/pricing');
const inputSchema  = require('../ai/inputSchema');
const resultStore  = require('../ai/resultStore');
const aiContext    = require('../ai/context');
const mediaLimits  = require('../ai/mediaLimits');
const { ValidationError } = require('../errors');
const { INTERNAL, PUBLIC_MESSAGES, toPublic, httpError } = require('../ai/errors');
const { STATUS, IN_FLIGHT } = queue;

// AI jobs from the user's side: the catalogue, pricing, submitting (charge +
// enqueue in one transaction), reading a job back, and the two ways a job ends —
// completing (files copied to our S3) and failing (credits refunded, exactly once).
//
// The app never sees a provider or a model name: not in the catalogue, not on a
// job, not in an error. Old app builds keep working through a provider switch.

const models = () => require('../models');
const MEDIA_SLOTS = ['media_library', resultStore.SLOT_NAME];

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

// PLAN ACCESS. An operation lists the plans allowed to use it (ai_operation_plans);
// none = every plan, Free and the access pass included. The user's plan is
// quota.effectivePlan: their active subscription (or pass), else the free plan.
const PLAN_ATTRS = ['id', 'uid', 'name', 'plan_type', 'status'];
const planInclude = () => ({ model: models().Plan, as: 'plans', attributes: PLAN_ATTRS, through: { attributes: [] }, required: false });

const planAllowed = (plans, planId) => !plans.length || plans.some((p) => p.id === planId);
// What the app may show as "available on …": the active plans only.
const unlockingPlans = (plans) => plans.filter((p) => p.status === 'active')
  .map((p) => ({ uid: p.uid, name: p.name, plan_type: p.plan_type }));

const publicOperation = (op, { planId }) => {
  const plans = op.plans || [];
  return {
    key: op.key,
    label: op.label,
    description: op.description,
    credits: Number(op.credits),
    unit: op.unit,
    input_schema: op.input_schema || { fields: {} },
    price_rules: op.price_rules || {},
    // false = not in this user's plan; `plans` says which ones unlock it.
    available: planAllowed(plans, planId),
    // [] = every plan.
    plans: unlockingPlans(plans),
  };
};

async function listOperations(userId) {
  const { AiOperation } = models();
  const ops = await AiOperation.findAll({
    where: { is_active: true }, include: [planInclude()],
    order: [['sort_order', 'ASC'], ['id', 'ASC']],
  });
  const plan = await quota.effectivePlan(userId);
  return ops.map((op) => publicOperation(op, { planId: plan?.planId ?? null }));
}

// Refuses, before anything is charged, an operation the user's plan does not include.
async function assertPlanAllowed(op, userId) {
  const { AiOperation } = models();
  const withPlans = await AiOperation.findByPk(op.id, { attributes: ['id'], include: [planInclude()] });
  const plans = withPlans?.plans || [];
  if (!plans.length) return;
  const plan = await quota.effectivePlan(userId);
  if (!planAllowed(plans, plan?.planId ?? null)) throw httpError.planRequired(unlockingPlans(plans));
}

async function activeOperation(key) {
  const { AiOperation } = models();
  const op = await AiOperation.findOne({ where: { key, is_active: true } });
  if (!op) throw httpError.operationNotFound();
  return op;
}

async function estimate(key, rawInput) {
  const op = await activeOperation(key);
  const input = inputSchema.validateInput(op.input_schema, rawInput);
  return { key: op.key, credits: pricing.computeCredits(op, input) };
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

const IDEMPOTENCY_RE = /^[A-Za-z0-9_\-.:]{8,64}$/;

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const hashInput = (key, input) => crypto.createHash('sha256').update(stableStringify({ key, input })).digest('hex');

// The same Idempotency-Key with the same request is the SAME job — a mobile
// retry must never charge twice. The same key with a different request is a
// client bug, and silently returning the first job would hide it.
function replayOrConflict(existing, key, hash) {
  if (existing.operation_key === key && existing.input_hash === hash) return { job: existing, replay: true };
  throw httpError.idempotencyReused();
}

// Every referenced upload must be the caller's own image, in the media library or
// a previous AI result. A uid that is someone else's is a 404, not a 403 — there
// is nothing to tell them.
// @returns [{ field, uid, content_type, bytes }] — the images, for assertMediaFits.
async function assertMediaOwned(op, input, userId) {
  const refs = inputSchema.mediaRefs(op.input_schema, input);
  if (!refs.length) return [];
  const { UserUpload } = models();
  const rows = await UserUpload.findAll({
    where: { user_id: userId, uid: refs.map((r) => r.uid), slot: MEDIA_SLOTS },
    attributes: ['uid', 'content_type', 'bytes'],
  });
  const byUid = new Map(rows.map((r) => [r.uid, r]));
  return refs.map((ref) => {
    const row = byUid.get(ref.uid);
    if (!row || !String(row.content_type || '').startsWith('image/')) throw httpError.inputNotFound(ref.field);
    return { field: ref.field, uid: ref.uid, content_type: String(row.content_type).toLowerCase(), bytes: Number(row.bytes || 0) };
  });
}

// Every image must suit every route the job may go to (adapter.inputLimits per
// model): a wrong format or an oversized file is a 400 here, before any charge,
// instead of a paid job that fails at send. The worker checks the real bytes again.
function assertMediaFits(media, cands) {
  if (!media.length) return;
  const problems = [];
  for (const c of cands) {
    const limits = c.adapter?.inputLimits?.(c.route.model);
    if (!limits) continue;
    for (const m of media) {
      if (limits.mimes && !limits.mimes.includes(m.content_type)) {
        problems.push({ field: m.field, message: `must be a ${mediaLimits.describe(limits.mimes)} image` });
      } else if (limits.maxBytes && m.bytes > limits.maxBytes) {
        problems.push({ field: m.field, message: `must be at most ${Math.floor(limits.maxBytes / mediaLimits.MB)} MB` });
      }
    }
  }
  const seen = new Set();
  const unique = problems.filter((p) => { const k = `${p.field}|${p.message}`; return seen.has(k) ? false : seen.add(k); });
  if (unique.length) throw new ValidationError('Validation failed', unique);
}

async function moderationStrikes(userId, since) {
  const { AiJob } = models();
  return AiJob.count({ where: { user_id: userId, error_code: 'MODERATION_BLOCKED', created_at: { [Op.gte]: since } } });
}

// In-flight jobs for the cap. A LOCKING read on purpose: it runs while this
// request holds the user's ai_credits counter lock (strict consume), and a plain
// SELECT would read the transaction's snapshot — which can predate a job another
// request committed while we waited for that lock.
async function inFlightCount(userId, transaction) {
  const { sequelize } = models();
  const [[row]] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM ai_jobs WHERE user_id = ? AND status IN (${IN_FLIGHT.map(() => '?').join(',')}) LOCK IN SHARE MODE`,
    { replacements: [userId, ...IN_FLIGHT], transaction },
  );
  return Number(row.n);
}

/**
 * Charge and enqueue. Order matters: everything that can refuse the request
 * without charging (validation, plan checks, a usable route) runs first; the
 * charge and the queue row then commit together, or not at all.
 *
 * @returns {{ job, replay: boolean }}
 */
async function submit(userId, key, rawInput, idempotencyKey) {
  if (!idempotencyKey || !IDEMPOTENCY_RE.test(idempotencyKey)) throw httpError.idempotencyRequired();

  const { AiJob, QuotaUsageEvent, sequelize } = models();
  const op    = await activeOperation(key);
  const input = inputSchema.validateInput(op.input_schema, rawInput);
  const hash  = hashInput(op.key, input);

  const existing = await AiJob.findOne({ where: { user_id: userId, idempotency_key: idempotencyKey } });
  if (existing) return replayOrConflict(existing, op.key, hash);

  const credits = pricing.computeCredits(op, input);

  await assertPlanAllowed(op, userId);
  if (!aiConfig.allowUnmetered() && (await quota.limitFor(userId, 'ai_credits')) === null) throw httpError.notInPlan();

  const media = await assertMediaOwned(op, input, userId);
  // Business / design details the server adds — resolved (and a foreign project
  // refused) before anything is charged, then frozen on the job.
  const context = await aiContext.build(op, input, userId);
  // A route the job may actually go to — a primary that forbids fallback and is
  // down right now does not count its fallbacks (refused here, nothing charged).
  const eligible = routing.eligible(await routing.candidates(op.id));
  if (!eligible.length) throw httpError.unavailable();
  assertMediaFits(media, eligible);

  const s = await aiConfig.settings();
  const since = new Date(Date.now() - 3600 * 1000);
  if ((await moderationStrikes(userId, since)) >= s.ai_moderation_strikes_per_hour) throw httpError.moderationCooldown();

  try {
    const job = await sequelize.transaction(async (transaction) => {
      const split = await quota.consume(userId, 'ai_credits', credits, {
        source: op.ledger_source, ref_type: 'ai_job', transaction, strict: true,
      });

      if ((await inFlightCount(userId, transaction)) >= s.ai_max_concurrent_jobs_per_user) {
        throw httpError.tooManyJobs(s.ai_max_concurrent_jobs_per_user);
      }

      const created = await AiJob.create({
        user_id: userId, operation_id: op.id, operation_key: op.key, status: STATUS.QUEUED,
        idempotency_key: idempotencyKey, input_hash: hash, input, context,
        credits_charged: credits,
        charge_split: split ? { ...split, source: op.ledger_source } : null,
        next_attempt_at: new Date(),
      }, { transaction });

      // The ledger row was written before the job had an id.
      if (split) {
        await QuotaUsageEvent.update({ ref_id: created.id }, { where: { uid: split.eventUid }, transaction });
      }
      return created;
    });
    // On the dispatching instance, send it now rather than at the next tick.
    require('../jobs/aiWorker.job').wake();
    return { job, replay: false };
  } catch (err) {
    // Two requests with the same key raced past the lookup above; the unique
    // index let one through and rolled the other back, charge included.
    if (err instanceof UniqueConstraintError) {
      const winner = await AiJob.findOne({ where: { user_id: userId, idempotency_key: idempotencyKey } });
      if (winner) return replayOrConflict(winner, op.key, hash);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Ending a job
// ---------------------------------------------------------------------------

// Moves the job to `failed` and refunds it, in ONE transaction, guarded by both
// the expected source state and refunded_at IS NULL — so whoever gets there first
// (worker, webhook, sweep, admin) refunds, and everyone else is a no-op.
// `internalCode` is ours (ai/errors INTERNAL); the job stores the PUBLIC code.
async function failJob(job, internalCode, { from, detail = null } = {}) {
  const { AiJob, sequelize } = models();
  const publicCode = toPublic(internalCode);
  const now = new Date();

  return sequelize.transaction(async (transaction) => {
    const moved = await queue.transition(job.id, from || IN_FLIGHT, {
      status: STATUS.FAILED, error_code: publicCode, error_message: PUBLIC_MESSAGES[publicCode],
      completed_at: now, refunded_at: now, finalizing_at: null,
    }, { transaction, where: { refunded_at: null } });
    if (!moved) return false;

    const fresh = await AiJob.findByPk(job.id, { transaction });
    let refund = { restoredPlan: 0, restoredTopup: 0, skipped: [] };
    if (fresh.user_id && fresh.charge_split) {
      refund = await quota.refund(fresh.user_id, 'ai_credits', fresh.charge_split, {
        source: fresh.charge_split.source, ref_type: 'ai_job', ref_id: fresh.id, transaction,
      });
    }
    await fresh.update({ refund_split: { ...refund, internal_code: internalCode, detail } }, { transaction });
    if (refund.skipped && refund.skipped.length) {
      console.warn(`[AI] job ${fresh.uid} refund partly skipped: ${JSON.stringify(refund.skipped)}`);
    }
    return true;
  });
}

// A text result (social post captions, …) is stored on the job itself: no S3
// copy, no storage charge. It must be a JSON object, and small.
const MAX_TEXT_RESULT_BYTES = 32 * 1024;

function checkText(text) {
  if (!text || typeof text !== 'object' || Array.isArray(text)) return 'text result is not an object';
  if (Buffer.byteLength(JSON.stringify(text), 'utf8') > MAX_TEXT_RESULT_BYTES) return 'text result is too large';
  return null;
}

// Stores the output and moves the job to `done`. `output` is what the adapter
// produced: { files?: [{ buffer|url }], text?: object } (at least one). Files are
// copied into OUR S3; text goes straight into ai_jobs.result. Claimed first via
// finalizing_at, so a webhook and a status check arriving together store once.
async function completeJob(job, output, adapter, { from, providerUnits } = {}) {
  const fromStates = from || [STATUS.PROCESSING, STATUS.UNKNOWN];
  const now = new Date();
  const claimed = await queue.transition(job.id, fromStates, { finalizing_at: now }, { where: { finalizing_at: null } });
  if (!claimed) return false;

  const hasText = output?.text !== undefined && output?.text !== null;
  const hasFiles = Array.isArray(output?.files) && output.files.length > 0;
  const result = {};
  if (hasText) {
    const bad = checkText(output.text);
    if (bad) {
      // The provider answered, but not with something we can hand the user.
      await failJob(job, INTERNAL.TASK_FAILED, { from: fromStates, detail: bad });
      return false;
    }
    result.text = output.text;
  }
  if (hasFiles || !hasText) {
    try {
      result.files = await resultStore.store(job, output?.files, adapter);
    } catch (err) {
      console.error(`[AI] job ${job.uid} result copy failed: ${err.message}`);
      // We paid for this output and cannot deliver it; the user is refunded.
      await failJob(job, INTERNAL.RESULT_FETCH_FAILED, { from: fromStates, detail: err.detail || err.message });
      return false;
    }
  }

  return queue.transition(job.id, fromStates, {
    status: STATUS.DONE, result, completed_at: new Date(), finalizing_at: null,
    ...(providerUnits !== undefined && providerUnits !== null ? { provider_units_actual: providerUnits } : {}),
  });
}

// A provider update (webhook or status check) for a job that was sent:
// { state: 'processing'|'done'|'failed', files?, text?, error? }.
async function applyProviderUpdate(job, update, adapter) {
  if (!update) return false;
  if (update.state === 'done') {
    const done = await completeJob(job, { files: update.files, text: update.text }, adapter, { providerUnits: update.providerUnits });
    if (done) await markAttempt(job, { outcome: 'done' });
    return done;
  }
  if (update.state === 'failed') {
    const code = update.error?.code || INTERNAL.TASK_FAILED;
    await markAttempt(job, { outcome: 'failed', error_code: code, error_detail: update.error?.detail || null });
    if (await retryElsewhere(job, code)) return true;
    return failJob(job, code, { from: [STATUS.PROCESSING, STATUS.UNKNOWN], detail: update.error?.detail || null });
  }
  await queue.transition(job.id, [STATUS.PROCESSING, STATUS.UNKNOWN], { last_status_check_at: new Date() });
  return false;
}

// The attempt row for the send that produced this update — its outcome was
// `accepted` until now. Also what keeps the failed route out of any retry.
async function markAttempt(job, fields) {
  const { AiJobAttempt } = models();
  await AiJobAttempt.update(
    { ...fields, finished_at: new Date() },
    { where: { job_id: job.id, attempt_no: job.attempts_count } },
  );
}

// A task that started and then failed on the provider's side gets ONE more go
// elsewhere — on a different route, never the one that failed it — when:
//   - the failure is not moderation or bad input (those fail everywhere, and a
//     blocked prompt is never shopped around),
//   - the job's route allows fallback (an "edit my product photo" route that must
//     not change model sets fallback_allowed false and simply fails + refunds),
//   - fewer than MAX_TASKS_PER_JOB tasks have STARTED at a provider (the original
//     plus one retry). Door refusals (429, 503) never count — they started nothing,
//     and counting them used to leave a job no retry at all after two 429s (B4),
//   - another usable route exists.
// The user is charged once per job, so a retry costs them nothing more; it goes
// back to `queued` and the dispatcher picks the route.
const MAX_TASKS_PER_JOB = 2;

async function retryElsewhere(job, code) {
  const { AiJob, AiJobAttempt, AiOperationRoute } = models();
  if (code !== INTERNAL.TASK_FAILED) return false;
  const fresh = await AiJob.findByPk(job.id);
  if (!fresh || !fresh.route_id) return false;
  // A started task is an attempt the provider accepted (it got a task id).
  const started = await AiJobAttempt.count({ where: { job_id: fresh.id, provider_task_id: { [Op.ne]: null } } });
  if (started >= MAX_TASKS_PER_JOB) return false;

  const route = await AiOperationRoute.findByPk(fresh.route_id);
  if (!route || !route.fallback_allowed) return false;

  const failed = new Set((await AiJobAttempt.findAll({
    where: { job_id: fresh.id, outcome: 'failed' }, attributes: ['route_id'],
  })).map((a) => a.route_id));
  const others = routing.eligible(await routing.candidates(fresh.operation_id)).filter((c) => !failed.has(c.route.id));
  if (!others.length) return false;

  return queue.transition(fresh.id, [STATUS.PROCESSING, STATUS.UNKNOWN], {
    status: STATUS.QUEUED, provider_task_id: null, sent_at: null, claimed_by: null,
    next_attempt_at: new Date(), last_status_check_at: null,
  }, { where: { finalizing_at: null } });
}

// Webhooks acknowledge at once and finish in the background (copying a result
// can outlast a provider's webhook timeout). Tracked so tests can wait for it.
const pending = new Set();
function track(promise) {
  const p = Promise.resolve(promise).catch((err) => console.error(`[AI] background update failed: ${err.message}`));
  pending.add(p);
  p.finally(() => pending.delete(p));
  return p;
}
const drain = () => Promise.all([...pending]);

// ---------------------------------------------------------------------------
// Reading jobs back
// ---------------------------------------------------------------------------

async function serialize(job, { cdnBase } = {}) {
  const base = cdnBase !== undefined ? cdnBase : String(await configSvc.getSetting('cdn_base_url', '') || '').replace(/\/+$/, '');
  const files = (job.result?.files || []).map((f) => ({
    media_uid: f.media_uid,
    s3_key: f.s3_key,
    url: base ? `${base}/${f.s3_key}` : null,
    mime: f.mime,
    width: f.width,
    height: f.height,
    // Audio results only; null for images (and for jobs stored before audio existed).
    duration_ms: f.duration_ms ?? null,
  }));
  return {
    uid: job.uid,
    operation_key: job.operation_key,
    status: job.status,
    credits_charged: Number(job.credits_charged),
    refunded: Boolean(job.refunded_at),
    error: job.status === STATUS.FAILED ? { code: job.error_code, message: job.error_message } : null,
    // `text` is additive: image jobs keep `{ files }` exactly as before.
    result: job.status === STATUS.DONE ? { files, text: job.result?.text ?? null } : null,
    created_at: job.created_at,
    completed_at: job.completed_at,
  };
}

async function getForUser(uid, userId) {
  const { AiJob } = models();
  const job = await AiJob.findOne({ where: { uid, user_id: userId } });
  if (!job) throw httpError.jobNotFound();
  return serialize(job);
}

async function listForUser(userId, { status, limit, offset } = {}) {
  const { AiJob } = models();
  const where = { user_id: userId };
  if (status) where.status = String(status).split(',').map((s) => s.trim()).filter(Boolean);
  const { rows, count } = await AiJob.findAndCountAll({
    where, order: [['id', 'DESC']],
    limit: Math.min(parseInt(limit, 10) || 20, 100),
    offset: Math.max(parseInt(offset, 10) || 0, 0),
  });
  const cdnBase = String(await configSvc.getSetting('cdn_base_url', '') || '').replace(/\/+$/, '');
  return { items: await Promise.all(rows.map((j) => serialize(j, { cdnBase }))), total: count };
}

module.exports = {
  listOperations, estimate, submit, failJob, completeJob, applyProviderUpdate, retryElsewhere, MAX_TASKS_PER_JOB,
  getForUser, listForUser, serialize, track, drain, hashInput, MEDIA_SLOTS, assertMediaFits,
};
