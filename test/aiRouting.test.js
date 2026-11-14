// Multi-provider routing: route choice (priority, weights, spillover, failover,
// max cost), the circuit breaker, retry on another route after a task fails, and
// provider balance alerts. Two real adapters: `fake` as the primary and
// `magnific` as the fallback, its HTTP answered by a stub — no network.
const crypto = require('node:crypto');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { v4: uuid } = require('uuid');

process.env.AI_SECRETS_MASTER_KEY = crypto.randomBytes(32).toString('base64');
process.env.AI_SECRETS_MASTER_KEY_VERSION = '1';
delete process.env.AI_PUBLIC_WEBHOOK_BASE_URL;

const h = require('./helpers');
const { models } = h;
const { AiProvider, AiProviderCredential, AiOperation, AiOperationRoute, AiJob, AiJobAttempt, AdminUser,
  ProviderCreditPurchase, User, UserSubscription, Plan, PlanFeature, FeatureType, UserUpload, UserQuotaCounter } = models;

const routing = require('../src/ai/routing');
const worker  = require('../src/ai/worker');
const balance = require('../src/ai/balance');
const aiHttp  = require('../src/ai/http');
const mailer  = require('../src/utils/mailer');
const s3      = require('../src/utils/s3Helper');
const credentialStore = require('../src/ai/credentialStore');
const fakeAdapter = require('../src/ai/providers/fake');

const P = '/api/v1';
const track = { users: [], ops: [], creds: [], plans: [], purchases: [], jobs: [] };
let fake;
let mag;
let magOriginal;
let fakeOriginal;
let plan;
let aiFeatureId;
let admin;
let seq = 0;
const orig = { request: aiHttp.request, download: aiHttp.download, upload: s3.uploadFile, mail: mailer.sendMailQuietly };
let magHandler = () => ({ status: 200, headers: {}, data: { data: { task_id: 'm-1', status: 'CREATED', generated: [] } } });
const magCalls = [];

before(async () => {
  await models.sequelize.authenticate();
  await h.start();
  aiHttp.request = async (opts) => { aiHttp.assertAllowedUrl(opts.url, opts.allowedHosts); magCalls.push(opts); return magHandler(opts); };
  aiHttp.download = async () => ({ bytes: fakeAdapter.PNG_1PX, contentType: 'image/png' });
  s3.uploadFile = async () => {};

  fake = await AiProvider.findOne({ where: { key: 'fake' } });
  mag  = await AiProvider.findOne({ where: { key: 'magnific' } });
  fakeOriginal = fake.toJSON();
  magOriginal = mag.toJSON();
  await mag.update({ status: 'active', settings: { webhook_secret_encoding: 'auto', capture_responses: false } });
  const k = await credentialStore.addPending(mag, 'api_key', `mk-${uuid()}`);
  track.creds.push(k.id);
  await credentialStore.activate(k.id);

  aiFeatureId = (await FeatureType.findOne({ where: { key: 'ai_credits' } })).id;
  plan = await Plan.create({ uid: uuid(), name: `TST Routing Plan ${Date.now()}`, plan_type: 'subscription', status: 'inactive' });
  track.plans.push(plan.id);
  await PlanFeature.create({ plan_id: plan.id, feature_type_id: aiFeatureId, value: 100 });
  admin = h.adminToken(['*'], (await AdminUser.findOne({ where: { email: 'admin@makemybrand.com' } })).id);
});

after(async () => {
  Object.assign(aiHttp, { request: orig.request, download: orig.download });
  s3.uploadFile = orig.upload;
  mailer.sendMailQuietly = orig.mail;
  if (track.jobs.length) await AiJob.destroy({ where: { id: track.jobs } });
  if (track.users.length) {
    await AiJob.destroy({ where: { user_id: track.users } });
    await UserUpload.destroy({ where: { user_id: track.users } });
    await User.destroy({ where: { id: track.users } });
  }
  if (track.ops.length) {
    await AiJob.destroy({ where: { operation_id: track.ops } });
    await AiOperationRoute.destroy({ where: { operation_id: track.ops } });
    await AiOperation.destroy({ where: { id: track.ops } });
  }
  await AiProviderCredential.destroy({ where: { id: track.creds } });
  if (track.purchases.length) await ProviderCreditPurchase.destroy({ where: { id: track.purchases } });
  await AiProvider.update({ status: magOriginal.status, settings: magOriginal.settings, cost_per_unit_inr: magOriginal.cost_per_unit_inr }, { where: { id: mag.id } });
  await AiProvider.update({ rate_limit_rpm: fakeOriginal.rate_limit_rpm }, { where: { id: fake.id } });
  if (track.plans.length) {
    await PlanFeature.destroy({ where: { plan_id: track.plans } });
    await Plan.destroy({ where: { id: track.plans } });
  }
  routing.clearCircuits();
  routing.clearTrips();
  credentialStore.clearCache();
  await h.stop();
  await models.sequelize.close();
});

beforeEach(() => {
  routing.clearCircuits();
  routing.clearTrips();
  worker.resetBuckets();
  credentialStore.clearCache();
  magCalls.length = 0;
});

// ---------- pure route choice ----------

// Synthetic candidates for choose(): { route, provider }.
let rid = 1000;
const cand = (providerId, over = {}) => ({
  route: { id: (rid += 1), priority: 100, weight: 100, fallback_allowed: true, max_cost_inr: null, provider_units: 75, ...over },
  provider: { id: providerId, cost_per_unit_inr: 0.0757, max_concurrency: 10 },
});
// A deterministic RNG (mulberry32), so weight tests are repeatable.
const seeded = (seed) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('weights share load among peers of one priority (a 5% canary gets ~5%)', () => {
  const main = cand(1, { weight: 95 });
  const canary = cand(2, { weight: 5 });
  const rng = seeded(42);
  let canaryHits = 0;
  for (let i = 0; i < 4000; i += 1) {
    if (routing.choose([main, canary], { rng }).cand === canary) canaryHits += 1;
  }
  const share = canaryHits / 4000;
  assert.ok(share > 0.03 && share < 0.07, `canary share ${share}`);

  const zero = cand(3, { weight: 0 });
  assert.equal(routing.choose([zero, main], { rng }).cand, main, 'weight 0 is only a last resort among peers');
  assert.equal(routing.choose([zero, { ...main, provider: { ...main.provider, id: 9 } }], { rng, hasBudget: (c) => c.provider.id !== 9 }).cand, zero);
});

test('spillover: a busy primary keeps the job queued until it has waited long enough, then a fallback takes it', () => {
  const primary = cand(1, { priority: 1 });
  const fallback = cand(2, { priority: 2 });
  const busy = (c) => c.provider.id !== 1;

  assert.equal(routing.choose([primary, fallback], { hasBudget: () => true }).cand, primary, 'a normal day: all on the primary');
  const early = routing.choose([primary, fallback], { hasBudget: busy, waitedMs: 10_000, spillAfterMs: 60_000 });
  assert.equal(early.cand, null);
  assert.equal(early.reason, 'waiting_budget', 'the queue smooths a burst — no spill yet');
  const late = routing.choose([primary, fallback], { hasBudget: busy, waitedMs: 61_000, spillAfterMs: 60_000 });
  assert.equal(late.cand, fallback);
  assert.equal(late.reason, 'spillover');
});

test('fallback_allowed false on the primary: the job waits rather than changing provider', () => {
  const primary = cand(1, { priority: 1, fallback_allowed: false });
  const fallback = cand(2, { priority: 2 });
  for (let i = 0; i < routing.CIRCUIT.threshold; i += 1) routing.recordFailure(1);
  const r = routing.choose([primary, fallback], { waitedMs: 10 * 60_000 });
  assert.equal(r.cand, null);
  assert.equal(r.reason, 'fallback_not_allowed');
});

test('B1: a primary that forbids fallback still gates it when its provider is unusable, over cost, or one of mixed peers', () => {
  const fallback = cand(2, { priority: 2 });

  // The primary's provider is tripped/disabled/keyless, so candidates() dropped it —
  // but its gate came along: the job waits, it never moves to the fallback.
  const down = Object.assign([fallback], { gate: { priority: 1, allowsFallback: false } });
  assert.deepEqual(routing.choose(down, { waitedMs: 60 * 60_000 }), { cand: null, reason: 'fallback_not_allowed' });
  assert.deepEqual(routing.eligible(down), [], 'a new request is refused as unavailable, nothing charged');

  // Same outage, primary allows fallback: straight over, reported as a failover.
  const ok = Object.assign([fallback], { gate: { priority: 1, allowsFallback: true } });
  assert.deepEqual(routing.choose(ok), { cand: fallback, reason: 'failover' });
  assert.deepEqual([...routing.eligible(ok)], [fallback]);

  // The primary is over its max_cost_inr: never silently replaced by the fallback.
  const pricey = cand(1, { priority: 1, provider_units: 200, max_cost_inr: 10, fallback_allowed: false });
  assert.deepEqual(routing.choose([pricey, fallback]), { cand: null, reason: 'no_route' });

  // Mixed primary peers: one forbidding is enough — no random peer decides.
  const a = cand(3, { priority: 1, fallback_allowed: true });
  const b = cand(4, { priority: 1, fallback_allowed: false });
  for (let i = 0; i < routing.CIRCUIT.threshold; i += 1) { routing.recordFailure(3); routing.recordFailure(4); }
  for (let i = 0; i < 20; i += 1) {
    assert.equal(routing.choose([a, b, fallback], { rng: Math.random }).reason, 'fallback_not_allowed');
  }
  assert.deepEqual(routing.gateOf([a.route, b.route, fallback.route]), { priority: 1, allowsFallback: false });
});

test('failover: an open circuit on the primary sends straight to the fallback without waiting', () => {
  const primary = cand(1, { priority: 1 });
  const fallback = cand(2, { priority: 2 });
  for (let i = 0; i < routing.CIRCUIT.threshold; i += 1) routing.recordFailure(1);
  const r = routing.choose([primary, fallback], { waitedMs: 0 });
  assert.equal(r.cand, fallback);
  assert.equal(r.reason, 'failover');
});

test('max_cost_inr keeps an expensive route from running at a loss; excluded routes are never chosen', () => {
  const pricey = cand(1, { priority: 1, provider_units: 200, max_cost_inr: 10 });   // 200 × 0.0757 = 15.14 > 10
  const cheap  = cand(2, { priority: 2 });
  assert.equal(routing.choose([pricey, cheap]).cand, cheap);
  assert.equal(routing.estCost(pricey), 200 * 0.0757);
  assert.equal(routing.choose([pricey]).reason, 'no_route');

  const a = cand(1);
  assert.equal(routing.choose([a], { excludeRouteIds: new Set([a.route.id]) }).reason, 'no_route');
});

test('a route that just refused this job at the door is tried after the others — and again if it is the only one', () => {
  const a = cand(1, { priority: 1 });
  const b = cand(2, { priority: 2 });
  assert.equal(routing.choose([a, b], { avoidRouteIds: new Set([a.route.id]) }).cand, b);
  const only = routing.choose([a], { avoidRouteIds: new Set([a.route.id]) });
  assert.equal(only.cand, a);
  assert.equal(only.reason, 'retry_same');
});

test('circuit breaker: opens after 5 refusals in 2 minutes, half-opens for exactly one probe, closes on success', () => {
  const t0 = 5_000_000;
  for (let i = 0; i < 4; i += 1) routing.recordFailure(7, t0 + i);
  assert.equal(routing.circuitState(7, t0 + 10), 'closed');
  routing.recordFailure(7, t0 + 10);
  assert.equal(routing.circuitState(7, t0 + 11), 'open');
  assert.equal(routing.admit(7, t0 + 11), false);

  const after = t0 + 10 + routing.CIRCUIT.openMs;
  assert.equal(routing.circuitState(7, after), 'half_open');
  assert.equal(routing.admit(7, after), true, 'one probe');
  assert.equal(routing.admit(7, after + 1), false, 'only one');
  routing.recordFailure(7, after + 2);
  assert.equal(routing.circuitState(7, after + 3), 'open', 'a failed probe re-opens it');

  const again = after + 2 + routing.CIRCUIT.openMs;
  assert.equal(routing.admit(7, again), true);
  routing.recordSuccess(7);
  assert.equal(routing.circuitState(7, again + 1), 'closed');

  // Failures spread over more than the window never open it.
  for (let i = 0; i < 6; i += 1) routing.recordFailure(8, t0 + i * 60_000);
  assert.equal(routing.circuitState(8, t0 + 6 * 60_000), 'closed');

  // A probe that never reports back does not hold the circuit shut forever.
  for (let i = 0; i < 5; i += 1) routing.recordFailure(9, t0);
  routing.admit(9, t0 + routing.CIRCUIT.openMs);
  assert.equal(routing.circuitState(9, t0 + 2 * routing.CIRCUIT.openMs + 1), 'half_open');
});

// ---------- end to end: fake primary, magnific fallback ----------

async function mkUser() {
  const user = await User.create({ uid: uuid(), name: 'TST Routing', phone: `5${String((Date.now() + (seq += 17)) % 1000000000).padStart(9, '0')}` });
  track.users.push(user.id);
  await UserSubscription.create({ uid: uuid(), user_id: user.id, plan_id: plan.id, sub_type: 'regular', status: 'active', starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 1 });
  return { id: user.id, token: h.userTokenFor(user.id) };
}

async function mkOp({ fakeParams = {}, primaryFallback = true } = {}) {
  const op = await AiOperation.create({
    key: `tst.route.${Date.now()}.${seq += 1}`, label: 'TST routed', credits: 1, unit: 'image', ledger_source: 'image_generation',
    is_active: true, input_schema: { fields: { prompt: { type: 'string', required: true } } },
  });
  track.ops.push(op.id);
  const primary = await AiOperationRoute.create({ operation_id: op.id, provider_id: fake.id, model: 'fake-image', fixed_params: { mode: 'async', ...fakeParams }, provider_units: 75, priority: 1, fallback_allowed: primaryFallback });
  const fallback = await AiOperationRoute.create({ operation_id: op.id, provider_id: mag.id, model: 'nano-banana-pro', fixed_params: { resolution: '2K' }, provider_units: 75, priority: 2 });
  return { op, primary, fallback };
}

const submit = (u, key) => h.request('POST', `${P}/ai/operations/${key}`, { token: u.token, body: { prompt: 'a lamp' }, headers: { 'Idempotency-Key': uuid() } });
const jobOf = (r) => AiJob.findOne({ where: { uid: r.body.data.uid } });
const used = async (userId) => Number((await UserQuotaCounter.findOne({ where: { user_id: userId, feature_type_id: aiFeatureId } }))?.used || 0);
const later = (ms) => new Date(Date.now() + ms);

test('a provider refusing at the door: the next try goes to the fallback (same job, one charge)', async () => {
  const u = await mkUser();
  const { op, fallback } = await mkOp({ fakeParams: { simulate: 'down' } });
  const r = await submit(u, op.key);
  await worker.dispatch(new Date()); await worker.drain();
  let job = await jobOf(r);
  assert.equal(job.status, 'queued', 'refused before anything started → requeued');

  await job.update({ next_attempt_at: new Date() });
  await worker.dispatch(new Date()); await worker.drain();
  job = await jobOf(r);
  assert.equal(job.status, 'processing');
  assert.equal(job.route_id, fallback.id, 'sent to the fallback');
  assert.equal(magCalls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(await used(u.id), 1, 'charged once for the job, whatever the attempts');
});

test('an open circuit on the primary: new jobs fail over immediately; when the primary recovers they come back', async () => {
  const u = await mkUser();
  const { op, primary, fallback } = await mkOp();
  for (let i = 0; i < routing.CIRCUIT.threshold; i += 1) routing.recordFailure(fake.id);

  const r = await submit(u, op.key);
  await worker.dispatch(new Date()); await worker.drain();
  assert.equal((await jobOf(r)).route_id, fallback.id);

  routing.clearCircuits();
  const r2 = await submit(u, op.key);
  await worker.dispatch(new Date()); await worker.drain();
  assert.equal((await jobOf(r2)).route_id, primary.id, 'back on the primary');

  const health = await h.request('GET', `${P}/admin/ai/health`, { token: admin });
  assert.ok(['closed', 'open', 'half_open'].includes(health.body.data.providers.find((p) => p.key === 'fake').circuit));
});

test('task failed after starting: retried ONCE on another route, never the one that failed, one charge', async () => {
  const u = await mkUser();
  const { op, primary, fallback } = await mkOp({ fakeParams: { simulate: 'fail_after_start' } });
  const r = await submit(u, op.key);
  await worker.dispatch(new Date()); await worker.drain();
  await worker.poll(later(5000));

  let job = await jobOf(r);
  assert.equal(job.status, 'queued', 'requeued for another route');
  assert.equal(job.provider_task_id, null);
  assert.equal(job.refunded_at, null);

  await worker.dispatch(new Date()); await worker.drain();
  job = await jobOf(r);
  assert.equal(job.route_id, fallback.id);
  magHandler = () => ({ status: 200, headers: {}, data: { data: { task_id: 'm-1', status: 'COMPLETED', generated: ['https://cdn-magnific.freepik.com/x.png'] } } });
  await worker.poll(later(5000));
  job = await jobOf(r);
  assert.equal(job.status, 'done');
  assert.equal(await used(u.id), 1);

  const attempts = await AiJobAttempt.findAll({ where: { job_id: job.id }, order: [['attempt_no', 'ASC']] });
  assert.deepEqual(attempts.map((a) => [a.route_id, a.outcome]), [[primary.id, 'failed'], [fallback.id, 'done']]);
  magHandler = () => ({ status: 200, headers: {}, data: { data: { task_id: 'm-1', status: 'CREATED', generated: [] } } });
});

test('no retry elsewhere when the route forbids fallback, or for moderation — failed and refunded', async () => {
  const u = await mkUser();
  const { op } = await mkOp({ fakeParams: { simulate: 'fail_after_start' }, primaryFallback: false });
  const r = await submit(u, op.key);
  await worker.dispatch(new Date()); await worker.drain();
  await worker.poll(later(5000));
  const job = await jobOf(r);
  assert.equal(job.status, 'failed');
  assert.ok(job.refunded_at);
  assert.equal(await used(u.id), 0);

  const { op: op2 } = await mkOp({ fakeParams: { simulate: 'moderation' } });
  const r2 = await submit(u, op2.key);
  await worker.dispatch(new Date()); await worker.drain();
  const j2 = await jobOf(r2);
  assert.equal(j2.error_code, 'MODERATION_BLOCKED');
  assert.equal(magCalls.length, 0, 'a blocked prompt is never shopped around');
});

test('B1 end to end: primary forbids fallback and its provider is tripped — new requests refused, queued jobs wait, never sent elsewhere', async () => {
  const u = await mkUser();
  const { op, primary } = await mkOp({ primaryFallback: false });
  const queued = await submit(u, op.key);
  assert.equal(queued.status, 202);

  routing.trip(fake.id, 'auth_failed');
  const refused = await submit(u, op.key);
  assert.equal(refused.status, 503, 'only a fallback is usable, and it may not be used');
  assert.equal(refused.body.error.code, 'AI_UNAVAILABLE');
  assert.equal(await used(u.id), 1, 'only the first job was charged');

  await worker.dispatch(new Date()); await worker.drain();
  let job = await jobOf(queued);
  assert.equal(job.status, 'queued', 'waits for its own provider');
  assert.equal(magCalls.length, 0, 'never sent to the fallback');

  assert.ok(job.next_attempt_at > new Date(), 'stepped aside for a few seconds (B2)');

  routing.clearTrips();
  await worker.dispatch(later(20 * 1000)); await worker.drain();
  job = await jobOf(queued);
  assert.equal(job.route_id, primary.id, 'goes out on the primary once it is back');
});

test('spillover end to end: the primary out of budget, the job waits, then spills after the wait', async () => {
  const u = await mkUser();
  const { op, fallback } = await mkOp();
  await fake.update({ rate_limit_rpm: 1 });      // bucket starts at 0.5 → no token
  worker.resetBuckets();
  try {
    const r = await submit(u, op.key);
    await worker.dispatch(new Date()); await worker.drain();
    let job = await jobOf(r);
    assert.equal(job.status, 'queued', 'waits for the primary first');
    // A minute later the 1-rpm bucket would have refilled: spend that token, so
    // the primary is still out of budget when the job's wait runs out.
    const t = later(61 * 1000);
    worker.takeToken({ id: fake.id, rate_limit_rpm: 1 }, t.getTime());
    await worker.dispatch(t); await worker.drain();
    job = await jobOf(r);
    assert.equal(job.route_id, fallback.id, 'spilled after ai_spillover_wait_seconds');
  } finally {
    await fake.update({ rate_limit_rpm: fakeOriginal.rate_limit_rpm });
  }
});

test('a slow synchronous send does not hold up the tick, and max_concurrency counts it across ticks', async () => {
  const u = await mkUser();
  const { op } = await mkOp({ fakeParams: { mode: 'sync', delay_ms: 400 } });
  await fake.update({ max_concurrency: 1 });
  try {
    const r1 = await submit(u, op.key);
    const t0 = Date.now();
    const d1 = await worker.dispatch(new Date());
    assert.equal(d1.dispatched, 1);
    assert.ok(Date.now() - t0 < 300, 'dispatch returned before the 400 ms call finished');
    assert.equal((await jobOf(r1)).status, 'sending');
    assert.equal(worker.activeFor(fake.id), 1);

    // A second job, next tick: the provider's one slot is still taken.
    const r2 = await submit(u, op.key);
    const d2 = await worker.dispatch(new Date());
    assert.equal(d2.dispatched, 0, 'over max_concurrency while the first call is open');
    assert.equal((await jobOf(r2)).status, 'queued');

    await worker.drain();
    assert.equal(worker.activeFor(fake.id), 0);
    assert.equal((await jobOf(r1)).status, 'done');
    await worker.dispatch(later(2000)); await worker.drain();
    assert.equal((await jobOf(r2)).status, 'done', 'sent once the slot freed');
  } finally {
    await fake.update({ max_concurrency: fakeOriginal.max_concurrency });
  }
});

// ---------- B2, B4, B5 ----------

test('B2: a backlog that cannot be sent steps aside, so the jobs behind it still go out', async () => {
  const u = await mkUser();
  const { op: stuck, primary, fallback } = await mkOp();
  await primary.update({ is_active: false });
  await fallback.update({ is_active: false });           // no route at all
  const { op: good } = await mkOp();
  const backlog = [];
  for (let i = 0; i < 55; i += 1) {
    backlog.push((await AiJob.create({
      uid: uuid(), user_id: u.id, operation_id: stuck.id, operation_key: stuck.key, status: 'queued',
      idempotency_key: uuid(), input_hash: '0'.repeat(64), input: { prompt: 'x' }, credits_charged: 0, next_attempt_at: new Date(),
    })).id);
  }
  try {
    const other = await mkUser();                            // u is at the in-flight cap
    const r = await submit(other, good.key);                 // newest of all: behind the 55
    assert.equal(r.status, 202, JSON.stringify(r.body));

    const first = await worker.dispatch(new Date()); await worker.drain();
    assert.ok(first.deferred >= 50, `the whole unsendable batch stepped aside (${first.deferred})`);
    await worker.dispatch(new Date()); await worker.drain();
    assert.equal((await jobOf(r)).status, 'processing', 'reached on the next tick, not starved');
  } finally {
    await AiJob.destroy({ where: { id: backlog } });
  }
});

test('B4: door refusals do not use up the one retry elsewhere', async () => {
  const u = await mkUser();
  const { op, primary, fallback } = await mkOp({ fakeParams: { simulate: 'fail_after_start' } });
  const r = await submit(u, op.key);
  let job = await jobOf(r);
  // Two 429s already happened on this job.
  for (let i = 1; i <= 2; i += 1) {
    await AiJobAttempt.create({ job_id: job.id, attempt_no: i, route_id: primary.id, outcome: 'requeued', error_code: 'RATE_LIMITED', started_at: new Date() });
  }
  await job.update({ attempts_count: 2 });

  await worker.dispatch(new Date()); await worker.drain();   // third claim: accepted, then fails
  await worker.poll(later(5000));
  job = await jobOf(r);
  assert.equal(job.status, 'queued', 'retried on another route despite 3 claims');
  await worker.dispatch(new Date()); await worker.drain();
  assert.equal((await jobOf(r)).route_id, fallback.id);
});

test('B5: an overdue queued job is AI_TIMEOUT when routes exist, AI_UNAVAILABLE only when none can take it', async () => {
  const u = await mkUser();
  const { op: routed } = await mkOp();
  const { op: dead, primary, fallback } = await mkOp();
  await primary.update({ is_active: false });
  await fallback.update({ is_active: false });
  const mk = async (o) => {
    const j = await AiJob.create({
      uid: uuid(), user_id: u.id, operation_id: o.id, operation_key: o.key, status: 'queued',
      idempotency_key: uuid(), input_hash: '0'.repeat(64), input: { prompt: 'x' }, credits_charged: 0,
      next_attempt_at: later(60 * 60 * 1000),               // waiting, never sent
    });
    // Relative to what was stored, so the server's timezone cannot shift it.
    await models.sequelize.query('UPDATE ai_jobs SET created_at = DATE_SUB(created_at, INTERVAL 2 HOUR) WHERE id = ?', { replacements: [j.id] });
    return j;
  };
  const waitedOnBudget = await mk(routed);
  const noRoute = await mk(dead);
  // The sweep takes 50 overdue jobs a pass; the test DB may hold older ones.
  for (let i = 0; i < 20; i += 1) {
    await worker.sweep(new Date());
    if ((await AiJob.count({ where: { id: [waitedOnBudget.id, noRoute.id], status: 'queued' } })) === 0) break;
  }
  assert.equal((await AiJob.findByPk(waitedOnBudget.id)).error_code, 'AI_TIMEOUT');
  assert.equal((await AiJob.findByPk(noRoute.id)).error_code, 'AI_UNAVAILABLE');
});

// ---------- provider balance ----------

test('provider balance: bought minus used, an alert once a day below the threshold, shown in Health', async () => {
  const p = await ProviderCreditPurchase.create({ provider_id: mag.id, purchased_at: new Date(Date.now() - 864e5), credits_received: 1000, amount_paid_inr: 75.7 });
  track.purchases.push(p.id);
  // Earlier tests in this file already sent Magnific jobs; top the purchase up by
  // exactly that so the numbers below are this test's own.
  const already = (await balance.balances()).find((x) => x.provider_key === 'magnific').used_units;
  await p.update({ credits_received: 1000 + already });
  const { op, fallback } = await mkOp();
  for (const units of [500, 450]) {
    const j = await AiJob.create({
      uid: uuid(), operation_id: op.id, operation_key: op.key, status: 'done', idempotency_key: uuid(), input_hash: '0'.repeat(64),
      route_id: fallback.id, provider_id: mag.id, provider_units: units, sent_at: new Date(), credits_charged: 1,
    });
    track.jobs.push(j.id);
  }

  const b = (await balance.balances()).find((x) => x.provider_key === 'magnific');
  assert.equal(b.remaining_units, 50);
  assert.equal(b.alert_below_units, Math.round((1000 + already) * 0.1), '10% of what was bought');
  assert.equal(b.low, true);
  assert.equal((await balance.balances()).find((x) => x.provider_key === 'fake'), undefined, 'no purchase → not tracked');

  const sent = [];
  mailer.sendMailQuietly = async (m) => { sent.push(m); return { sent: false }; };
  process.env.AI_ALERT_EMAILS = 'ops@example.com, cto@example.com';
  try {
    assert.deepEqual(await balance.checkAndAlert(), ['magnific']);
    assert.equal(sent.length, 2);
    assert.match(sent[0].subject, /Low magnific AI balance/);
    assert.deepEqual(await balance.checkAndAlert(), [], 'not again the same day');
    assert.equal(sent.length, 2);
    assert.deepEqual(await balance.checkAndAlert(new Date(Date.now() + 25 * 3600e3)), ['magnific'], 'again a day later');
  } finally {
    delete process.env.AI_ALERT_EMAILS;
    mailer.sendMailQuietly = orig.mail;
  }

  const health = await h.request('GET', `${P}/admin/ai/health`, { token: admin });
  const m = health.body.data.providers.find((x) => x.key === 'magnific');
  assert.equal(m.balance.remaining_units, 50);
  assert.equal(m.balance.low, true);
});
