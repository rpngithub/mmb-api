// AI jobs: credentials, pricing, the charge/refund path, the queue state machine
// and the webhook — all on the `fake` adapter. Nothing here touches the network,
// a real provider or S3 (s3Helper.uploadFile is stubbed for the whole file).
const crypto = require('node:crypto');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { v4: uuid } = require('uuid');

// A master key for this process only — set BEFORE anything reads it.
process.env.AI_SECRETS_MASTER_KEY = crypto.randomBytes(32).toString('base64');
process.env.AI_SECRETS_MASTER_KEY_VERSION = '1';
delete process.env.AI_ALLOW_UNMETERED;
delete process.env.AI_PUBLIC_WEBHOOK_BASE_URL;

const h = require('./helpers');
const { models } = h;
const { User, UserSubscription, Plan, PlanFeature, FeatureType, UserQuotaGrant, UserQuotaCounter,
  UserQuotaUsage, AiProvider, AiOperation, AiOperationRoute, AiJob, AiJobAttempt, AiProviderCredential,
  UserUpload, QuotaUsageEvent } = models;

const secretBox       = require('../src/utils/secretBox');
const credentialStore = require('../src/ai/credentialStore');
const pricing         = require('../src/ai/pricing');
const inputSchema     = require('../src/ai/inputSchema');
const aiHttp          = require('../src/ai/http');
const worker          = require('../src/ai/worker');
const queue           = require('../src/ai/queue');
const aiJobs          = require('../src/services/aiJob.service');
const quota           = require('../src/services/quota.service');
const s3              = require('../src/utils/s3Helper');

const P = '/api/v1';
const track = { users: [], ops: [], creds: [], plans: [] };
let fake;            // the seeded fake provider
let plan;            // a test plan carrying an ai_credits allowance
let aiFeatureId;
let seq = 0;
const stored = [];   // S3 keys "uploaded" by the stubbed uploadFile
const originalUpload = s3.uploadFile;

before(async () => {
  await models.sequelize.authenticate();
  await h.start();
  s3.uploadFile = async (key) => { stored.push(key); };

  fake = await AiProvider.findOne({ where: { key: 'fake' } });
  assert.ok(fake, 'the dev/test seeder creates the fake provider');
  aiFeatureId = (await FeatureType.findOne({ where: { key: 'ai_credits' } })).id;

  plan = await Plan.create({ uid: uuid(), name: `TST AI Plan ${Date.now()}`, plan_type: 'subscription', status: 'inactive' });
  track.plans.push(plan.id);
  await PlanFeature.create({ plan_id: plan.id, feature_type_id: aiFeatureId, value: 10 });
});

after(async () => {
  s3.uploadFile = originalUpload;
  const userIds = track.users;
  if (userIds.length) {
    const jobIds = (await AiJob.findAll({ where: { user_id: userIds }, attributes: ['id'] })).map((j) => j.id);
    if (jobIds.length) await AiJob.destroy({ where: { id: jobIds } });   // cascades attempts
    await UserUpload.destroy({ where: { user_id: userIds } });
    await UserQuotaGrant.destroy({ where: { user_id: userIds } });
    await User.destroy({ where: { id: userIds } });
  }
  if (track.ops.length) {
    // Jobs whose owner is gone (SET NULL) still pin the operation.
    await AiJob.destroy({ where: { operation_id: track.ops } });
    await AiOperationRoute.destroy({ where: { operation_id: track.ops } });
    await AiOperation.destroy({ where: { id: track.ops } });
  }
  if (track.creds.length) await AiProviderCredential.destroy({ where: { id: track.creds } });
  if (track.plans.length) {
    await PlanFeature.destroy({ where: { plan_id: track.plans } });
    await Plan.destroy({ where: { id: track.plans } });
  }
  credentialStore.clearCache();
  await h.stop();
  await models.sequelize.close();
});

beforeEach(() => {
  worker.resetBuckets();
  credentialStore.clearCache();
  credentialStore._setClock(null);
  require('../src/ai/routing').clearCircuits();
});

// ---------- fixtures ----------

async function mkUser({ credits = 10, subscribed = true } = {}) {
  const user = await User.create({ uid: uuid(), name: 'TST AI User', phone: `8${String((Date.now() + (seq += 7)) % 1000000000).padStart(9, '0')}` });
  track.users.push(user.id);
  if (subscribed) {
    await PlanFeature.update({ value: credits }, { where: { plan_id: plan.id, feature_type_id: aiFeatureId } });
    await UserSubscription.create({
      uid: uuid(), user_id: user.id, plan_id: plan.id, sub_type: 'regular', status: 'active',
      starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 1,
    });
  }
  return { id: user.id, uid: user.uid, token: h.userTokenFor(user.id) };
}

// An operation with one fake route behaving as `fixed`.
async function mkOp(fixed = {}, over = {}) {
  const op = await AiOperation.create({
    key: `tst.${Date.now()}.${seq += 1}`, label: 'TST op', credits: 1, unit: 'image',
    ledger_source: 'image_generation', is_active: true,
    input_schema: { fields: {
      prompt: { type: 'string', required: true, min: 1, max: 500 },
      num_images: { type: 'integer', min: 1, max: 4, default: 1 },
      quality: { type: 'enum', values: ['low', 'high'], default: 'low' },
      image: { type: 'media' },
    } },
    price_rules: { units_from: 'num_images', multipliers: { quality: { low: 1, high: 3 } } },
    ...over,
  });
  track.ops.push(op.id);
  await AiOperationRoute.create({
    operation_id: op.id, provider_id: fake.id, model: 'fake-image-secret-model',
    fixed_params: { mode: 'async', ...fixed }, provider_units: 75,
  });
  return op;
}

const submit = (u, key, body, idem = uuid()) => h.request('POST', `${P}/ai/operations/${key}`, {
  token: u.token, body, headers: { 'Idempotency-Key': idem },
});
const used = async (userId) => {
  const row = await UserQuotaCounter.findOne({ where: { user_id: userId, feature_type_id: aiFeatureId } });
  return row ? Number(row.used) : 0;
};
const jobByUid = (uid) => AiJob.findOne({ where: { uid } });
const later = (ms) => new Date(Date.now() + ms);

// ---------- secretBox ----------

test('secretBox: round trip, and any tampering or a moved row fails to decrypt', () => {
  const box = secretBox.encrypt('sk-live-abcdef1234', 'fake:api_key');
  assert.equal(secretBox.decrypt(box, 'fake:api_key'), 'sk-live-abcdef1234');
  assert.equal(secretBox.last4('sk-live-abcdef1234'), '1234');

  const flipped = Buffer.from(box.ciphertext); flipped[0] ^= 1;
  assert.throws(() => secretBox.decrypt({ ...box, ciphertext: flipped }, 'fake:api_key'), secretBox.SecretBoxError);
  assert.throws(() => secretBox.decrypt(box, 'other:api_key'), secretBox.SecretBoxError, 'a value copied to another provider row will not decrypt');
  assert.throws(() => secretBox.decrypt({ ...box, version: 9 }, 'fake:api_key'), /no master key configured for version 9/);
});

test('secretBox: errors never carry the plaintext, and a missing master key is a clear error', () => {
  const box = secretBox.encrypt('super-secret-value', 'fake:api_key');
  try { secretBox.decrypt({ ...box, authTag: Buffer.alloc(16) }, 'fake:api_key'); } catch (err) {
    assert.ok(!String(err.message).includes('super-secret-value'));
    assert.ok(!String(err.stack).includes('super-secret-value'));
  }
  const saved = process.env.AI_SECRETS_MASTER_KEY;
  delete process.env.AI_SECRETS_MASTER_KEY;
  try {
    assert.equal(secretBox.isConfigured(), false);
    assert.throws(() => secretBox.encrypt('x', 'a'), /AI_SECRETS_MASTER_KEY is not configured/);
  } finally { process.env.AI_SECRETS_MASTER_KEY = saved; }
});

// ---------- credential store ----------

test('credentials: pending is never used, activation retires the old key, values never leave unencrypted', async () => {
  const p = { id: fake.id, key: 'fake', credential_source: 'db' };
  const a = await credentialStore.addPending(p, 'api_key', `key-A-${uuid()}`);
  track.creds.push(a.id);
  assert.equal(a.ciphertext, undefined, 'the default scope never returns the ciphertext');
  assert.equal(await credentialStore.apiKey(p), null, 'a pending key is not used');

  await credentialStore.activate(a.id);
  const first = await credentialStore.apiKey(p);
  assert.match(first, /^key-A-/);

  const b = await credentialStore.addPending(p, 'api_key', `key-B-${uuid()}`);
  track.creds.push(b.id);
  await credentialStore.activate(b.id);
  assert.match(await credentialStore.apiKey(p), /^key-B-/);
  assert.equal((await AiProviderCredential.findByPk(a.id)).status, 'retired');

  const raw = await AiProviderCredential.unscoped().findByPk(b.id);
  assert.ok(!raw.ciphertext.toString('utf8').includes('key-B-'), 'stored as ciphertext');
  await AiProviderCredential.update({ status: 'retired', retired_at: new Date() }, { where: { id: [a.id, b.id] } });
});

test('credentials: the decrypted key is cached for a minute, so a rotation lands within one', async () => {
  let now = Date.now();
  credentialStore._setClock(() => now);
  const p = { id: fake.id, key: 'fake', credential_source: 'db' };
  const a = await credentialStore.addPending(p, 'api_key', 'cache-A-0001');
  track.creds.push(a.id);
  await credentialStore.activate(a.id);
  assert.equal(await credentialStore.apiKey(p), 'cache-A-0001');

  // Rotate behind the cache's back (another instance did it).
  const b = await credentialStore.addPending(p, 'api_key', 'cache-B-0002');
  track.creds.push(b.id);
  await AiProviderCredential.update({ status: 'retired', retired_at: new Date() }, { where: { id: a.id } });
  await AiProviderCredential.update({ status: 'active', activated_at: new Date() }, { where: { id: b.id } });
  assert.equal(await credentialStore.apiKey(p), 'cache-A-0001', 'still cached');
  now += credentialStore.CACHE_MS + 1;
  assert.equal(await credentialStore.apiKey(p), 'cache-B-0002', 'picked up after the cache window');
  await AiProviderCredential.update({ status: 'retired', retired_at: new Date() }, { where: { id: b.id } });
});

test('credentials: env fallback reads a fixed variable name; webhook secrets overlap after rotation', async () => {
  const envP = { id: -1, key: 'fake', credential_source: 'env' };
  process.env.AI_PROVIDER_FAKE_API_KEY = 'from-env-123';
  try { assert.equal(await credentialStore.apiKey(envP), 'from-env-123'); } finally { delete process.env.AI_PROVIDER_FAKE_API_KEY; }
  assert.equal(credentialStore.envName('magnific', 'webhook_secret'), 'AI_PROVIDER_MAGNIFIC_WEBHOOK_SECRET');

  const p = { id: fake.id, key: 'fake', credential_source: 'db' };
  const oldS = await credentialStore.addPending(p, 'webhook_secret', 'whsec-old-1');
  const newS = await credentialStore.addPending(p, 'webhook_secret', 'whsec-new-2');
  track.creds.push(oldS.id, newS.id);
  await credentialStore.activate(oldS.id);
  await credentialStore.activate(newS.id);
  const secrets = await credentialStore.webhookSecrets(p);
  assert.ok(secrets.includes('whsec-new-2') && secrets.includes('whsec-old-1'), 'the just-retired secret is still accepted');

  await AiProviderCredential.update({ retired_at: new Date(Date.now() - 48 * 3600e3) }, { where: { id: oldS.id } });
  credentialStore.clearCache();
  assert.deepEqual(await credentialStore.webhookSecrets(p), ['whsec-new-2'], 'outside the overlap window it is dropped');
});

// ---------- pricing, input, http ----------

test('pricing: credits × units × multipliers, rounded up; the client cannot set the price', () => {
  const op = { credits: 2, price_rules: { units_from: 'num_images', multipliers: { quality: { low: 1, high: 1.5 } } } };
  assert.equal(pricing.computeCredits(op, { num_images: 1, quality: 'low' }), 2);
  assert.equal(pricing.computeCredits(op, { num_images: 3, quality: 'high' }), 9);
  assert.equal(pricing.computeCredits({ credits: 1, price_rules: { multipliers: { q: { a: 1.1 } } } }, { q: 'a' }), 2);
  assert.equal(pricing.computeCredits({ credits: 10, price_rules: { multipliers: { q: { a: 1.1 } } } }, { q: 'a' }), 11, 'no float creep past an exact product');
  assert.throws(() => pricing.computeCredits(op, { quality: 'ultra' }), /Validation failed/);

  const schema = { fields: { prompt: { type: 'string', required: true }, num_images: { type: 'integer', min: 1, max: 4, default: 1 } } };
  const v = inputSchema.validateInput(schema, { prompt: 'hi', credits: 0, model: 'x' });
  assert.deepEqual(v, { prompt: 'hi', num_images: 1 }, 'unknown fields — a client-sent price included — are dropped');
  assert.throws(() => inputSchema.validateInput(schema, { num_images: 9 }), /Validation failed/);
  assert.match(pricing.checkRules({ multipliers: { quality: { low: 1 } } }, { fields: { quality: { type: 'enum', values: ['low', 'high'] } } }), /no price for high/);
  assert.match(inputSchema.checkDefinition({ fields: { Bad: { type: 'string' } } }), /snake_case/);
});

test('ai/http: never leaks headers from a transport error, and refuses hosts the adapter did not declare', () => {
  const axiosLike = Object.assign(new Error('timeout of 30000ms exceeded'), {
    code: 'ECONNABORTED', config: { headers: { 'X-Magnific-API-Key': 'sk-should-never-appear' } },
  });
  const clean = aiHttp.sanitize(axiosLike);
  const dump = JSON.stringify({ ...clean, message: clean.message, stack: clean.stack });
  assert.ok(!dump.includes('sk-should-never-appear'));
  assert.equal(clean.phase, 'after_send', 'a timeout may have reached the provider');
  assert.equal(aiHttp.sanitize(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).phase, 'before_send');

  assert.throws(() => aiHttp.assertAllowedUrl('https://evil.example.com/x', ['api.magnific.com']), /not allowed/);
  assert.throws(() => aiHttp.assertAllowedUrl('http://api.magnific.com/x', ['api.magnific.com']), /non-https/);
  assert.ok(aiHttp.assertAllowedUrl('https://cdn.x.magnific.com/a.png', ['*.magnific.com']));
});

// ---------- catalogue ----------

test('GET /ai/operations lists the catalogue without any provider or model name', async () => {
  const u = await mkUser();
  const op = await mkOp();
  const r = await h.request('GET', `${P}/ai/operations`, { token: u.token });
  assert.equal(r.status, 200);
  const mine = r.body.data.find((o) => o.key === op.key);
  assert.ok(mine);
  assert.equal(mine.credits, 1);
  const dump = JSON.stringify(r.body);
  assert.ok(!dump.includes('fake-image-secret-model') && !/provider/i.test(dump), 'no provider or model leaks');

  const est = await h.request('POST', `${P}/ai/operations/${op.key}/estimate`, { token: u.token, body: { prompt: 'x', num_images: 2, quality: 'high' } });
  assert.equal(est.body.data.credits, 6);
});

// ---------- submit ----------

test('submit charges once per Idempotency-Key; a different body with the same key is a 409', async () => {
  const u = await mkUser({ credits: 10 });
  const op = await mkOp();
  const idem = uuid();

  const first = await submit(u, op.key, { prompt: 'a cat', num_images: 2 }, idem);
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(first.body.data.status, 'queued');
  assert.equal(first.body.data.credits_charged, 2);
  assert.equal(await used(u.id), 2);

  const replay = await submit(u, op.key, { prompt: 'a cat', num_images: 2 }, idem);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.uid, first.body.data.uid);
  assert.equal(await used(u.id), 2, 'a retry charged nothing');

  const clash = await submit(u, op.key, { prompt: 'a dog' }, idem);
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, 'AI_IDEMPOTENCY_KEY_REUSED');

  const none = await h.request('POST', `${P}/ai/operations/${op.key}`, { token: u.token, body: { prompt: 'x' } });
  assert.equal(none.body.error.code, 'AI_IDEMPOTENCY_KEY_REQUIRED');

  const ev = await QuotaUsageEvent.findOne({ where: { user_id: u.id, source: 'image_generation' } });
  const job = await jobByUid(first.body.data.uid);
  assert.equal(ev.ref_type, 'ai_job');
  assert.equal(ev.ref_id, job.id, 'the ledger row points at the job');
});

test('submit refuses before charging: no credits (402), unmetered (403), plan not included, unknown op, foreign image, no route', async () => {
  const op = await mkOp();

  const broke = await mkUser({ credits: 1 });
  const big = await submit(broke, op.key, { prompt: 'x', num_images: 2 });
  assert.equal(big.status, 402);
  assert.equal(big.body.error.code, 'QUOTA_EXCEEDED');
  assert.equal(await AiJob.count({ where: { user_id: broke.id } }), 0, 'no job row when the charge fails');
  assert.equal(await used(broke.id), 0);

  const freeloader = await mkUser({ subscribed: false });
  const free = await models.Plan.findAll({ where: { plan_type: 'free', status: 'active' } });
  await models.Plan.update({ status: 'inactive' }, { where: { id: free.map((p) => p.id) } });
  try {
    const r = await submit(freeloader, op.key, { prompt: 'x' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'AI_NOT_IN_PLAN', 'an unmetered account would spend real money without a ceiling');
    process.env.AI_ALLOW_UNMETERED = 'true';
    const allowed = await submit(freeloader, op.key, { prompt: 'x' });
    assert.equal(allowed.status, 202, 'dev/test opt-in');
  } finally {
    delete process.env.AI_ALLOW_UNMETERED;
    if (free.length) await models.Plan.update({ status: 'active' }, { where: { id: free.map((p) => p.id) } });
  }

  // Plan access: an operation limited to other plans is refused before charging,
  // naming the plans that include it; adding the user's plan lets it through.
  const u = await mkUser({ credits: 10 });
  const restricted = await mkOp();
  const elite = await models.Plan.create({ uid: uuid(), name: `TST Elite ${Date.now()}`, plan_type: 'subscription', status: 'active' });
  track.plans.push(elite.id);
  await models.AiOperationPlan.create({ operation_id: restricted.id, plan_id: elite.id });
  const refused = await submit(u, restricted.key, { prompt: 'x' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'AI_PLAN_REQUIRED');
  assert.equal(refused.body.error.details[0].plan_uid, elite.uid, 'says which plan unlocks it');
  assert.equal(await used(u.id), 0, 'nothing charged');
  const listed = (await h.request('GET', `${P}/ai/operations`, { token: u.token })).body.data.find((o) => o.key === restricted.key);
  assert.equal(listed.available, false);
  assert.deepEqual(listed.plans.map((p) => p.uid), [elite.uid]);
  assert.equal(listed.is_premium_only, undefined, 'the old flag is gone');
  await models.AiOperationPlan.create({ operation_id: restricted.id, plan_id: plan.id });
  assert.equal((await submit(u, restricted.key, { prompt: 'x' })).status, 202, 'the user\'s plan is now included');
  const open = (await h.request('GET', `${P}/ai/operations`, { token: u.token })).body.data.find((o) => o.key === op.key);
  assert.deepEqual([open.available, open.plans], [true, []], 'no plans listed = every plan');

  assert.equal((await submit(u, 'no.such.op', { prompt: 'x' })).body.error.code, 'AI_OPERATION_NOT_FOUND');

  const other = await mkUser();
  const upload = await UserUpload.create({ user_id: other.id, s3_key: `users/${other.uid}/media/${uuid()}.png`, slot: 'media_library', bytes: 10, content_type: 'image/png' });
  const foreign = await submit(u, op.key, { prompt: 'x', image: upload.uid });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error.code, 'AI_INPUT_NOT_FOUND');

  const before = await used(u.id);
  const orphan = await mkOp();
  await AiOperationRoute.update({ is_active: false }, { where: { operation_id: orphan.id } });
  const noRoute = await submit(u, orphan.key, { prompt: 'x' });
  assert.equal(noRoute.status, 503);
  assert.equal(noRoute.body.error.code, 'AI_UNAVAILABLE');
  assert.equal(await used(u.id), before, 'nothing charged when no provider can take it');
});

test('parallel submits cannot overspend: five requests on a 2-credit balance, exactly two go through', async () => {
  const u = await mkUser({ credits: 2 });
  const op = await mkOp();
  await UserQuotaUsage.create({ user_id: u.id }).catch(() => {});
  const results = await Promise.all(Array.from({ length: 5 }, () => submit(u, op.key, { prompt: 'race' })));
  const ok = results.filter((r) => r.status === 202).length;
  const refused = results.filter((r) => r.status === 402).length;
  assert.equal(ok, 2, results.map((r) => r.status).join(','));
  assert.equal(refused, 3);
  assert.equal(await used(u.id), 2, 'the counter never passes the plan limit');
  assert.equal(await AiJob.count({ where: { user_id: u.id } }), 2);
});

test('the per-user concurrency cap refuses a fourth job in flight', async () => {
  const u = await mkUser({ credits: 10 });
  const op = await mkOp();
  for (let i = 0; i < 3; i += 1) assert.equal((await submit(u, op.key, { prompt: `j${i}` })).status, 202);
  const fourth = await submit(u, op.key, { prompt: 'j3' });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.error.code, 'AI_TOO_MANY_JOBS');
  assert.equal(await used(u.id), 3, 'the refused request was not charged');
});

// ---------- the worker ----------

test('async job: dispatch -> processing -> status poll -> done, files land in our S3 and the media library', async () => {
  const u = await mkUser({ credits: 10 });
  const op = await mkOp();
  const r = await submit(u, op.key, { prompt: 'a rocket', num_images: 2 });

  await worker.dispatch(new Date()); await worker.drain();
  let job = await jobByUid(r.body.data.uid);
  assert.equal(job.status, 'processing');
  assert.match(job.provider_task_id, /^fake_/);
  assert.equal(job.model, 'fake-image-secret-model', 'the route is snapshotted on the job');
  assert.equal(Number(job.provider_units), 75);
  assert.equal(await AiJobAttempt.count({ where: { job_id: job.id, outcome: 'accepted' } }), 1);

  await worker.poll(later(5000));
  job = await jobByUid(r.body.data.uid);
  assert.equal(job.status, 'done');
  assert.equal(job.result.files.length, 2);
  assert.ok(stored.includes(job.result.files[0].s3_key));
  assert.ok(job.result.files[0].s3_key.startsWith(`users/${u.uid}/ai/${job.uid}/`));

  const lib = await h.request('GET', `${P}/uploads?slot=ai_result`, { token: u.token });
  assert.equal(lib.status, 200);

  const view = await h.request('GET', `${P}/ai/jobs/${job.uid}`, { token: u.token });
  assert.equal(view.body.data.status, 'done');
  assert.equal(view.body.data.result.files.length, 2);
  assert.ok(!JSON.stringify(view.body).includes('fake'), 'no provider, model or task id reaches the app');

  const other = await mkUser();
  assert.equal((await h.request('GET', `${P}/ai/jobs/${job.uid}`, { token: other.token })).status, 404);
});

test('sync job (background removal shape) is done straight from dispatch', async () => {
  const u = await mkUser({ credits: 10 });
  const op = await mkOp({ mode: 'sync' }, { ledger_source: 'background_removal' });
  const r = await submit(u, op.key, { prompt: 'x' });
  await worker.dispatch(new Date()); await worker.drain();
  const job = await jobByUid(r.body.data.uid);
  assert.equal(job.status, 'done');
  assert.equal(job.result.files.length, 1);
});

test('text job: the result is stored on the job — no S3 copy, no storage charge — and served as result.text', async () => {
  const u = await mkUser({ credits: 10 });
  const op = await mkOp({ mode: 'sync', output: 'text' }, { unit: 'text', ledger_source: 'text_generation' });
  const before = stored.length;
  const r = await submit(u, op.key, { prompt: 'caption my diwali post' });
  await worker.dispatch(new Date()); await worker.drain();

  const job = await jobByUid(r.body.data.uid);
  assert.equal(job.status, 'done');
  assert.deepEqual(job.result.text.options[0].hashtags, ['#sample', '#mmb']);
  assert.equal(job.result.files, undefined);
  assert.equal(stored.length, before, 'nothing copied to S3');
  assert.equal(await UserUpload.count({ where: { user_id: u.id } }), 0, 'nothing in the media library');
  assert.equal(Number(job.provider_units_actual), 0.05, 'the adapter-reported cost is recorded');

  const view = await h.request('GET', `${P}/ai/jobs/${job.uid}`, { token: u.token });
  assert.equal(view.body.data.result.text.options[0].caption, 'A sample caption.');
  assert.deepEqual(view.body.data.result.files, []);

  // Image jobs carry text: null — the shape only grew.
  const img = await mkOp({ mode: 'sync' });
  const r2 = await submit(u, img.key, { prompt: 'x' });
  await worker.dispatch(new Date()); await worker.drain();
  const v2 = await h.request('GET', `${P}/ai/jobs/${r2.body.data.uid}`, { token: u.token });
  assert.equal(v2.body.data.result.files.length, 1);
  assert.equal(v2.body.data.result.text, null);
});

test('text job: a result that is not a small JSON object fails and refunds', async () => {
  const u = await mkUser({ credits: 10 });
  const op = await mkOp({ mode: 'sync' }, { unit: 'text', ledger_source: 'text_generation' });
  const r = await submit(u, op.key, { prompt: 'x' });
  const job = await jobByUid(r.body.data.uid);
  await job.update({ status: 'sending' });
  assert.equal(await aiJobs.completeJob(job, { text: ['not', 'an', 'object'] }, {}, { from: 'sending' }), false);
  const failed = await jobByUid(r.body.data.uid);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.refunded_at);
  assert.equal(await used(u.id), 0);
});

test('moderation: failed, refunded to the counter, never tried again elsewhere', async () => {
  const u = await mkUser({ credits: 10 });
  const op = await mkOp({ simulate: 'moderation' });
  const r = await submit(u, op.key, { prompt: 'x' });
  assert.equal(await used(u.id), 1);

  await worker.dispatch(new Date()); await worker.drain();
  const job = await jobByUid(r.body.data.uid);
  assert.equal(job.status, 'failed');
  assert.equal(job.error_code, 'MODERATION_BLOCKED');
  assert.ok(job.refunded_at);
  assert.equal(await used(u.id), 0, 'the credit is back');
  assert.equal(await AiJobAttempt.count({ where: { job_id: job.id } }), 1, 'one attempt only');

  const view = await h.request('GET', `${P}/ai/jobs/${job.uid}`, { token: u.token });
  assert.equal(view.body.data.refunded, true);
  assert.equal(view.body.data.error.code, 'MODERATION_BLOCKED');
});

test('provider down before send: requeued with backoff, not failed, not charged twice', async () => {
  const u = await mkUser({ credits: 10 });
  const op = await mkOp({ simulate: 'down' });
  const r = await submit(u, op.key, { prompt: 'x' });
  await worker.dispatch(new Date()); await worker.drain();
  const job = await jobByUid(r.body.data.uid);
  assert.equal(job.status, 'queued');
  assert.ok(job.next_attempt_at > new Date(), 'backed off');
  assert.equal(job.attempts_count, 1);
  const attempt = await AiJobAttempt.findOne({ where: { job_id: job.id } });
  assert.equal(attempt.outcome, 'requeued');
  assert.equal(attempt.error_code, 'PROVIDER_DOWN', 'the internal code stays on the attempt');
  assert.equal(await used(u.id), 1);

  // Out of attempts -> failed as AI_UNAVAILABLE, which is all the user learns.
  // The limit counts door refusals (requeued attempts), so record 3 more of them.
  for (let i = 0; i < worker.MAX_SEND_ATTEMPTS - 2; i += 1) {
    await AiJobAttempt.create({ job_id: job.id, attempt_no: 100 + i, outcome: 'requeued', error_code: 'PROVIDER_DOWN', started_at: new Date() });
  }
  await job.update({ next_attempt_at: new Date() });
  await worker.dispatch(new Date()); await worker.drain();
  const done = await jobByUid(r.body.data.uid);
  assert.equal(done.status, 'failed');
  assert.equal(done.error_code, 'AI_UNAVAILABLE');
  assert.equal(await used(u.id), 0);
});

test('timeout after send: unknown, never resent, then failed and refunded after the resolve window', async () => {
  const u = await mkUser({ credits: 10 });
  const op = await mkOp({ simulate: 'timeout_after_send' });
  const r = await submit(u, op.key, { prompt: 'x' });
  await worker.dispatch(new Date()); await worker.drain();
  let job = await jobByUid(r.body.data.uid);
  assert.equal(job.status, 'unknown');

  await worker.dispatch(later(60 * 1000)); await worker.drain();
  assert.equal(await AiJobAttempt.count({ where: { job_id: job.id } }), 1, 'an unknown job is never sent again');

  await worker.sweep(later(31 * 60 * 1000));
  job = await jobByUid(r.body.data.uid);
  assert.equal(job.status, 'failed');
  assert.equal(job.error_code, 'AI_TIMEOUT');
  assert.equal(await used(u.id), 0);
});

test('a sender that died mid-send is swept to unknown, never back to queued', async () => {
  const u = await mkUser({ credits: 10 });
  const op = await mkOp();
  const r = await submit(u, op.key, { prompt: 'x' });
  const job = await jobByUid(r.body.data.uid);
  await job.update({ status: 'sending', claimed_at: new Date(Date.now() - 60 * 1000), provider_id: fake.id });
  await worker.sweep(new Date());
  assert.equal((await jobByUid(job.uid)).status, 'unknown');
});

test('task failed after starting: failed and refunded on the status check', async () => {
  const u = await mkUser({ credits: 10 });
  const op = await mkOp({ simulate: 'fail_after_start' });
  const r = await submit(u, op.key, { prompt: 'x' });
  await worker.dispatch(new Date()); await worker.drain();
  await worker.poll(later(5000));
  const job = await jobByUid(r.body.data.uid);
  assert.equal(job.status, 'failed');
  assert.equal(job.error_code, 'AI_FAILED');
  assert.equal(job.refund_split.internal_code, 'TASK_FAILED');
  assert.equal(await used(u.id), 0);
});

test('two claims on one job: exactly one wins', async () => {
  const u = await mkUser({ credits: 10 });
  const op = await mkOp();
  const r = await submit(u, op.key, { prompt: 'x' });
  const job = await jobByUid(r.body.data.uid);
  const [a, b] = await Promise.all([
    queue.claim(job, { now: new Date(), instance: 'a' }),
    queue.claim(job, { now: new Date(), instance: 'b' }),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);
  await AiJob.update({ status: 'failed', refunded_at: new Date() }, { where: { id: job.id } });
});

test('the token bucket holds a provider to its per-minute budget', () => {
  const provider = { id: 999999, rate_limit_rpm: 4 };
  const t0 = 1_000_000;
  // A new leader starts half full: 2 tokens.
  assert.equal(worker.takeToken(provider, t0), true);
  assert.equal(worker.takeToken(provider, t0), true);
  assert.equal(worker.takeToken(provider, t0), false);
  assert.equal(worker.takeToken(provider, t0 + 15_000), true, '4/min refills one every 15 s');
  assert.equal(worker.takeToken(provider, t0 + 15_000), false);
});

// ---------- webhooks ----------

test('webhook: a signed completion finishes the job; bad signature 401; replay is a no-op; unknown provider 404', async () => {
  const p = { id: fake.id, key: 'fake', credential_source: 'db' };
  const secret = `whsec-${uuid()}`;
  const cred = await credentialStore.addPending(p, 'webhook_secret', secret);
  track.creds.push(cred.id);
  await credentialStore.activate(cred.id);

  const u = await mkUser({ credits: 10 });
  const op = await mkOp({ complete_after_ms: 10 * 60 * 1000 });
  const r = await submit(u, op.key, { prompt: 'x' });
  await worker.dispatch(new Date()); await worker.drain();
  const job = await jobByUid(r.body.data.uid);
  assert.equal(job.status, 'processing');

  const raw = Buffer.from(JSON.stringify({ task_id: job.provider_task_id, status: 'COMPLETED' }));
  const sign = (s) => crypto.createHmac('sha256', s).update(raw).digest('hex');

  const bad = await h.request('POST', `${P}/webhooks/ai/fake`, { body: raw, headers: { 'x-fake-signature': sign('wrong') } });
  assert.equal(bad.status, 401);

  const ok = await h.request('POST', `${P}/webhooks/ai/fake`, { body: raw, headers: { 'x-fake-signature': sign(secret) } });
  assert.equal(ok.status, 200);
  await aiJobs.drain();
  const done = await jobByUid(job.uid);
  assert.equal(done.status, 'done');
  const files = done.result.files.length;

  const again = await h.request('POST', `${P}/webhooks/ai/fake`, { body: raw, headers: { 'x-fake-signature': sign(secret) } });
  assert.equal(again.status, 200);
  await aiJobs.drain();
  assert.equal((await jobByUid(job.uid)).result.files.length, files, 'a replayed webhook changes nothing');

  const unknownTask = Buffer.from(JSON.stringify({ task_id: 'fake_nope', status: 'COMPLETED' }));
  const ignored = await h.request('POST', `${P}/webhooks/ai/fake`, {
    body: unknownTask, headers: { 'x-fake-signature': crypto.createHmac('sha256', secret).update(unknownTask).digest('hex') },
  });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.body.data.ignored, 'unknown_task');

  assert.equal((await h.request('POST', `${P}/webhooks/ai/nobody`, { body: raw })).status, 404);
  await AiProviderCredential.update({ status: 'retired', retired_at: new Date(Date.now() - 48 * 3600e3) }, { where: { id: cred.id } });
});

// ---------- refunds ----------

test('refund puts credits back where they came from: plan share on the counter, top-up share on the exact grants', async () => {
  const u = await mkUser({ credits: 2 });
  const g1 = await UserQuotaGrant.create({ uid: uuid(), user_id: u.id, feature_type_id: aiFeatureId, quantity: 1, status: 'active', source: 'admin_grant', granted_at: new Date() });
  const g2 = await UserQuotaGrant.create({ uid: uuid(), user_id: u.id, feature_type_id: aiFeatureId, quantity: 5, status: 'active', source: 'admin_grant', granted_at: new Date() });
  const op = await mkOp({ simulate: 'moderation' }, { credits: 5 });

  const r = await submit(u, op.key, { prompt: 'x' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const job = await jobByUid(r.body.data.uid);
  assert.equal(job.charge_split.fromPlan, 2);
  assert.equal(job.charge_split.fromTopup, 3);
  assert.deepEqual(job.charge_split.grantDebits, [{ grantId: g1.id, amount: 1 }, { grantId: g2.id, amount: 2 }], 'FIFO, oldest grant first');

  await worker.dispatch(new Date()); await worker.drain();
  assert.equal(await used(u.id), 0);
  assert.equal(Number((await UserQuotaGrant.findByPk(g1.id)).consumed), 0);
  assert.equal(Number((await UserQuotaGrant.findByPk(g2.id)).consumed), 0);

  // The ledger nets to zero for this job, and the Usage breakdown shows nothing spent.
  const net = await QuotaUsageEvent.sum('amount', { where: { user_id: u.id, ref_type: 'ai_job', ref_id: job.id } });
  assert.equal(Number(net), 0);
  const usage = await quota.usageSummary(u.id, { withBreakdown: true });
  const ai = usage.features.find((f) => f.key === 'ai_credits');
  assert.equal((ai.breakdown || []).length, 0, 'a fully refunded source drops out of the breakdown');

  // A second refund attempt does nothing.
  assert.equal(await aiJobs.failJob(job, 'TASK_FAILED'), false);
  assert.equal(await used(u.id), 0);
});

test('refund after the window rolled: the plan share is lost, the top-up share still comes back; revoked grants are skipped', async () => {
  const u = await mkUser({ credits: 1 });
  const g = await UserQuotaGrant.create({ uid: uuid(), user_id: u.id, feature_type_id: aiFeatureId, quantity: 5, status: 'active', source: 'admin_grant', granted_at: new Date() });
  const op = await mkOp({ complete_after_ms: 10 * 60 * 1000 }, { credits: 3 });
  const r = await submit(u, op.key, { prompt: 'x' });
  const job = await jobByUid(r.body.data.uid);
  assert.equal(job.charge_split.fromPlan, 1);
  assert.equal(job.charge_split.fromTopup, 2);

  // The account moved to a new period in between.
  await UserQuotaUsage.update({ period_start: '2000-01-01' }, { where: { user_id: u.id } });
  await aiJobs.failJob(job, 'TASK_FAILED');
  const failed = await jobByUid(job.uid);
  assert.equal(failed.refund_split.restoredPlan, 0);
  assert.equal(failed.refund_split.restoredTopup, 2);
  assert.equal(failed.refund_split.skipped[0].reason, 'period_rolled');
  assert.equal(await used(u.id), 1, 'the old period\'s allowance is not credited to the new one');
  assert.equal(Number((await UserQuotaGrant.findByPk(g.id)).consumed), 0);

  // Revoked grant: skipped and recorded, nothing credited.
  const u2 = await mkUser({ credits: 0 });
  const g2 = await UserQuotaGrant.create({ uid: uuid(), user_id: u2.id, feature_type_id: aiFeatureId, quantity: 3, status: 'active', source: 'admin_grant', granted_at: new Date() });
  const r2 = await submit(u2, op.key, { prompt: 'y' });
  assert.equal(r2.status, 202, JSON.stringify(r2.body));
  await g2.update({ status: 'revoked' });
  const job2 = await jobByUid(r2.body.data.uid);
  await aiJobs.failJob(job2, 'TASK_FAILED');
  const f2 = await jobByUid(job2.uid);
  assert.equal(f2.refund_split.restoredTopup, 0);
  assert.equal(f2.refund_split.skipped[0].reason, 'grant_inactive');
});

test('job history lists the user\'s own jobs only', async () => {
  const u = await mkUser({ credits: 10 });
  const op = await mkOp();
  await submit(u, op.key, { prompt: 'one' });
  await submit(u, op.key, { prompt: 'two' });
  const r = await h.request('GET', `${P}/ai/jobs`, { token: u.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.meta.total, 2);
  assert.ok(r.body.data.every((j) => j.operation_key === op.key));
});
