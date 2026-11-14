// The Magnific adapter, offline. Every HTTP call is answered by a stub standing in
// for ai/http.js — nothing here reaches Magnific or any network.
//
// The response shapes below are the ASSUMED ones (see src/ai/providers/magnific.js):
// the docs show no response JSON for these models. When a live session captures
// real responses, replace these fixtures with them.
const crypto = require('node:crypto');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { v4: uuid } = require('uuid');

process.env.AI_SECRETS_MASTER_KEY = crypto.randomBytes(32).toString('base64');
process.env.AI_SECRETS_MASTER_KEY_VERSION = '1';
delete process.env.AI_PUBLIC_WEBHOOK_BASE_URL;
delete process.env.AI_ALLOW_UNMETERED;

const h = require('./helpers');
const { models } = h;
const { AiProvider, AiProviderCredential, AiOperation, AiOperationRoute, AiJob, AiJobAttempt, AdminUser,
  User, UserSubscription, Plan, PlanFeature, FeatureType, UserUpload, UserQuotaCounter } = models;

const aiHttp  = require('../src/ai/http');
const s3      = require('../src/utils/s3Helper');
const worker  = require('../src/ai/worker');
const routing = require('../src/ai/routing');
const aiJobs  = require('../src/services/aiJob.service');
const credentialStore = require('../src/ai/credentialStore');
const magnific = require('../src/ai/providers/magnific');
const fakeAdapter = require('../src/ai/providers/fake');
const { INTERNAL, ProviderError } = require('../src/ai/errors');

const P = '/api/v1';
const API_KEY = `mk-live-${uuid()}`;
const WEBHOOK_SECRET = `whsec_${crypto.randomBytes(24).toString('base64')}`;
const track = { users: [], ops: [], creds: [], plans: [] };
let provider;
let originalProvider;
let admin;
let aiFeatureId;
let plan;
let seq = 0;

// ---------- the transport stub ----------
const calls = [];
let handler = () => ({ status: 500, headers: {}, data: { message: 'no handler' } });
const orig = { request: aiHttp.request, download: aiHttp.download, uploadFile: s3.uploadFile, presign: s3.getPresignedUrl };

before(async () => {
  await models.sequelize.authenticate();
  await h.start();
  aiHttp.request = async (opts) => {
    aiHttp.assertAllowedUrl(opts.url, opts.allowedHosts);   // the real allowlist still applies
    calls.push(opts);
    return handler(opts);
  };
  aiHttp.download = async (url, { allowedHosts } = {}) => {
    aiHttp.assertAllowedUrl(url, allowedHosts);
    calls.push({ method: 'DOWNLOAD', url });
    return { bytes: fakeAdapter.PNG_1PX, contentType: 'image/png' };
  };
  s3.uploadFile = async () => {};
  s3.getPresignedUrl = async (key) => `https://mmb-bucket.s3.ap-south-1.amazonaws.com/${key}?X-Amz-Signature=abc`;

  provider = await AiProvider.findOne({ where: { key: 'magnific' } });
  assert.ok(provider, 'migration 062 inserts the magnific provider');
  assert.equal(provider.status, 'disabled', '…disabled until an admin turns it on');
  originalProvider = provider.toJSON();
  await provider.update({ status: 'active' });

  const k = await credentialStore.addPending(provider, 'api_key', API_KEY);
  const w = await credentialStore.addPending(provider, 'webhook_secret', WEBHOOK_SECRET);
  track.creds.push(k.id, w.id);
  await credentialStore.activate(k.id);
  await credentialStore.activate(w.id);

  const row = await AdminUser.findOne({ where: { email: 'admin@makemybrand.com' } });
  admin = h.adminToken(['*'], row.id);
  aiFeatureId = (await FeatureType.findOne({ where: { key: 'ai_credits' } })).id;
  plan = await Plan.create({ uid: uuid(), name: `TST Magnific Plan ${Date.now()}`, plan_type: 'subscription', status: 'inactive' });
  track.plans.push(plan.id);
  await PlanFeature.create({ plan_id: plan.id, feature_type_id: aiFeatureId, value: 100 });
});

after(async () => {
  Object.assign(aiHttp, { request: orig.request, download: orig.download });
  s3.uploadFile = orig.uploadFile;
  s3.getPresignedUrl = orig.presign;
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
  await AiProvider.update({ status: originalProvider.status, settings: originalProvider.settings }, { where: { id: provider.id } });
  if (track.plans.length) {
    await PlanFeature.destroy({ where: { plan_id: track.plans } });
    await Plan.destroy({ where: { id: track.plans } });
  }
  credentialStore.clearCache();
  routing.clearTrips();
  await h.stop();
  await models.sequelize.close();
});

beforeEach(() => {
  calls.length = 0;
  worker.resetBuckets();
  routing.clearTrips();
  routing.clearCircuits();
  credentialStore.clearCache();
});

// ---------- fixtures ----------
async function mkUser() {
  const user = await User.create({ uid: uuid(), name: 'TST Magnific', phone: `6${String((Date.now() + (seq += 13)) % 1000000000).padStart(9, '0')}` });
  track.users.push(user.id);
  await UserSubscription.create({ uid: uuid(), user_id: user.id, plan_id: plan.id, sub_type: 'regular', status: 'active', starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 1 });
  return { id: user.id, uid: user.uid, token: h.userTokenFor(user.id) };
}

const SCHEMAS = {
  image: { fields: { prompt: { type: 'string', required: true }, aspect_ratio: { type: 'enum', values: ['1:1', '9:16'], default: '1:1' }, reference_images: { type: 'media_list', max: 3 } } },
  product: { fields: { prompt: { type: 'string', required: true }, product_image: { type: 'media', required: true } } },
  poster: { fields: { prompt: { type: 'string', required: true }, aspect_ratio: { type: 'enum', values: ['1:1', '9:16'], default: '1:1' }, num_images: { type: 'integer', min: 1, max: 4, default: 1 }, quality: { type: 'enum', values: ['low', 'medium', 'high'] } } },
  bg: { fields: { image: { type: 'media', required: true } } },
};

async function mkRoute(model, schema, fixed = {}, credits = 1) {
  const op = await AiOperation.create({
    key: `tst.mag.${Date.now()}.${seq += 1}`, label: `TST ${model}`, credits, unit: 'image',
    ledger_source: schema === SCHEMAS.bg ? 'background_removal' : 'image_generation', is_active: true, input_schema: schema,
  });
  track.ops.push(op.id);
  await AiOperationRoute.create({ operation_id: op.id, provider_id: provider.id, model, fixed_params: fixed, provider_units: 75 });
  return op;
}

async function mkImage(u, bytes = 1024) {
  return UserUpload.create({ user_id: u.id, s3_key: `users/${u.uid}/media/${uuid()}.png`, slot: 'media_library', bytes, content_type: 'image/png' });
}

const submit = (u, key, body) => h.request('POST', `${P}/ai/operations/${key}`, { token: u.token, body, headers: { 'Idempotency-Key': uuid() } });
const jobOf = async (r) => AiJob.findOne({ where: { uid: r.body.data.uid } });
const used = async (userId) => Number((await UserQuotaCounter.findOne({ where: { user_id: userId, feature_type_id: aiFeatureId } }))?.used || 0);
const later = (ms) => new Date(Date.now() + ms);
const posts = () => calls.filter((c) => c.method === 'POST');

// ASSUMED shapes (see the header of src/ai/providers/magnific.js).
const created   = (taskId) => ({ status: 200, headers: {}, data: { data: { task_id: taskId, status: 'CREATED', generated: [] } } });
const completed = (taskId, urls) => ({ status: 200, headers: {}, data: { data: { task_id: taskId, status: 'COMPLETED', generated: urls } } });

const noKeyAnywhere = async (job) => {
  const rows = await AiJobAttempt.findAll({ where: { job_id: job.id } });
  const dump = JSON.stringify({ job: (await AiJob.findByPk(job.id)).toJSON(), rows: rows.map((r) => r.toJSON()) });
  assert.ok(!dump.includes(API_KEY), 'the API key appears in no job or attempt row');
};

// ---------- unit: request building ----------

test('body building: Nano Banana gets reference images as URLs, one image max, and never more than 3 references', () => {
  const spec = magnific.MODELS['nano-banana-pro'];
  const ref = (n) => ({ uid: `u${n}`, url: `https://mmb-bucket.s3.ap-south-1.amazonaws.com/${n}.png`, content_type: 'image/png', bytes: 1000 });
  const body = magnific._buildBody(spec, { prompt: 'a cake', aspect_ratio: '9:16', product_image: ref(0), reference_images: [ref(1)] }, { resolution: '2K' }, 'https://api.example/cb');
  assert.deepEqual(body, {
    prompt: 'a cake', aspect_ratio: '9:16', resolution: '2K',
    reference_images: [{ image: ref(0).url, mime_type: 'image/png' }, { image: ref(1).url, mime_type: 'image/png' }],
    webhook_url: 'https://api.example/cb',
  });
  assert.throws(() => magnific._buildBody(spec, { prompt: 'x', reference_images: [ref(1), ref(2), ref(3), ref(4)] }, {}), /at most 3 reference/);
  assert.throws(() => magnific._buildBody(spec, { prompt: 'x', num_images: 2 }, {}), /at most 1 image/);
  assert.throws(() => magnific._buildBody(spec, { prompt: 'x', reference_images: [{ ...ref(1), bytes: 21 * 1024 * 1024 }] }, {}), /larger than 20 MB/);
});

test('body building: GPT image always sends quality, maps aspect ratios, never lowers moderation', () => {
  const g2 = magnific._buildBody(magnific.MODELS['gpt-image-2'], { prompt: 'sale', aspect_ratio: '1:1' }, { resolution: '1k', aspect_ratio_map: { '1:1': 'square_1_1' } });
  assert.equal(g2.quality, 'medium', 'Magnific defaults gpt-image-2 to HIGH — we never leave it to the default');
  assert.equal(g2.aspect_ratio, 'square_1_1');
  assert.equal(g2.num_images, undefined);

  const g25 = magnific._buildBody(magnific.MODELS['gpt-image-2-5'], { prompt: 'sale', num_images: 3, quality: 'low' }, { background: 'transparent', extra_body: { variant: 'flare' } });
  assert.equal(g25.num_images, 3);
  assert.equal(g25.quality, 'low');
  assert.equal(g25.background, 'transparent');
  assert.equal(g25.output_format, 'png');
  assert.equal(g25.moderation, 'auto', 'moderation is never "low"');
  assert.equal(g25.variant, 'flare');
  assert.throws(() => magnific._buildBody(magnific.MODELS['gpt-image-2'], { prompt: 'x', quality: 'max' }, {}), /quality must be one of/);
});

test('validateRoute: unknown models, values the model does not take, and stray params are refused', () => {
  const v = (model, f) => magnific.validateRoute({ model, fixedParams: f });
  assert.match(v('imagen-4', {}), /model must be one of/);
  assert.match(v('nano-banana-pro', { resolution: '8K' }), /resolution must be one of 1K, 2K, 4K/);
  assert.match(v('gpt-image-2', { background: 'transparent' }), /background must be one of opaque, auto/);
  assert.match(v('gpt-image-2-5', { background: 'transparent', output_format: 'jpeg' }), /transparent background needs png or webp/);
  assert.match(v('nano-banana-pro', { body_encoding: 'form' }), /remove-background only/);
  assert.match(v('nano-banana-pro', { extra_body: { moderation: 'low' } }), /extra_body may only set/);
  assert.match(v('nano-banana-pro', { seed: 1 }), /unknown fixed_params/);
  assert.equal(v('remove-background', { body_encoding: 'form' }), null);
  assert.equal(v('nano-banana-pro', { resolution: '4K', extra_body: { thinking_level: 'high' } }), null);
});

// ---------- unit: parsing ----------

test('task parsing: status words, generated URLs, completed-with-nothing and moderated failures', () => {
  const p = magnific._parseTask;
  assert.equal(p({ data: { task_id: 't', status: 'IN_PROGRESS' } }).state, 'processing');
  assert.equal(p({ data: { task_id: 't', status: 'CREATED' } }).state, 'processing');
  const done = p({ data: { task_id: 't', status: 'COMPLETED', generated: ['https://cdn-magnific.freepik.com/a.png', { url: 'https://cdn.freepik.com/b.png' }] } });
  assert.equal(done.state, 'done');
  assert.deepEqual(done.files.map((f) => f.url), ['https://cdn-magnific.freepik.com/a.png', 'https://cdn.freepik.com/b.png']);
  assert.equal(p({ task_id: 't', status: 'completed', generated: ['https://cdn.freepik.com/c.png'] }).state, 'done', 'top-level fields and lower case too');

  const empty = p({ data: { task_id: 't', status: 'COMPLETED', generated: [], has_nsfw: [true] } });
  assert.equal(empty.state, 'failed');
  assert.equal(empty.error.code, INTERNAL.MODERATION_BLOCKED, 'completed with no image and an nsfw flag is a moderation block');
  assert.equal(p({ data: { task_id: 't', status: 'COMPLETED', generated: [] } }).error.code, INTERNAL.TASK_FAILED);

  assert.equal(p({ data: { task_id: 't', status: 'FAILED', error: 'Prompt flagged by safety system' } }).error.code, INTERNAL.MODERATION_BLOCKED);
  assert.equal(p({ data: { task_id: 't', status: 'FAILED', error: 'internal' } }).error.code, INTERNAL.TASK_FAILED);
});

test('error mapping: every HTTP status lands in the right code and phase', () => {
  const e = (status, data = {}, headers = {}) => magnific._errorFromResponse({ status, data, headers });
  const row = (status, data, code, phase) => {
    const err = e(status, data);
    assert.equal(err.code, code, `${status} ${JSON.stringify(data)}`);
    assert.equal(err.phase, phase, `${status} phase`);
  };
  row(400, { message: 'aspect_ratio is invalid' }, INTERNAL.INVALID_INPUT, 'before_send');
  row(422, { message: 'Content violates our safety policy' }, INTERNAL.MODERATION_BLOCKED, 'before_send');
  row(401, {}, INTERNAL.AUTH_FAILED, 'before_send');
  row(403, { message: 'Invalid API key' }, INTERNAL.AUTH_FAILED, 'before_send');
  row(403, { message: 'Insufficient credits' }, INTERNAL.PROVIDER_OUT_OF_CREDITS, 'before_send');
  row(402, {}, INTERNAL.PROVIDER_OUT_OF_CREDITS, 'before_send');
  row(429, {}, INTERNAL.RATE_LIMITED, 'before_send');
  row(404, {}, INTERNAL.PROVIDER_DOWN, 'before_send');
  row(503, {}, INTERNAL.PROVIDER_DOWN, 'before_send');
  row(500, {}, INTERNAL.TIMEOUT, 'after_send');
  assert.equal(e(429, {}, { 'retry-after': '7' }).retryAfterMs, 7000);
  assert.ok(e(500, { message: 'boom' }).responseExcerpt.includes('boom'));
});

// ---------- full flows through the real worker ----------

test('Nano Banana async: POST with the key → task id → status poll → files copied to our S3 → done', async () => {
  const u = await mkUser();
  const img = await mkImage(u);
  const op = await mkRoute('nano-banana-pro', SCHEMAS.product, { resolution: '2K' });

  handler = () => created('nb-task-1');
  const r = await submit(u, op.key, { prompt: 'Product on a marble table', product_image: img.uid });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await worker.dispatch(new Date()); await worker.drain();

  const post = posts()[0];
  assert.equal(post.url, 'https://api.magnific.com/v1/ai/text-to-image/nano-banana-pro');
  assert.equal(post.headers['x-magnific-api-key'], API_KEY);
  assert.equal(post.data.resolution, '2K');
  assert.match(post.data.reference_images[0].image, /^https:\/\/mmb-bucket\.s3\..*X-Amz-Signature/, 'the product photo goes as a short-lived presigned URL');
  assert.equal(post.data.webhook_url, undefined, 'no public base URL configured → no callback, the job is polled');

  let job = await jobOf(r);
  assert.equal(job.status, 'processing');
  assert.equal(job.provider_task_id, 'nb-task-1');

  handler = (opts) => {
    assert.equal(opts.url, 'https://api.magnific.com/v1/ai/text-to-image/nano-banana-pro/nb-task-1');
    return completed('nb-task-1', ['https://cdn-magnific.freepik.com/out/1.png']);
  };
  await worker.poll(later(5000));
  job = await jobOf(r);
  assert.equal(job.status, 'done');
  assert.equal(job.result.files.length, 1);
  assert.ok(calls.some((c) => c.method === 'DOWNLOAD' && c.url.includes('cdn-magnific.freepik.com')));
  const view = await h.request('GET', `${P}/ai/jobs/${job.uid}`, { token: u.token });
  assert.ok(!/magnific|freepik|nano/i.test(JSON.stringify(view.body)), 'the app never sees the provider, model or its URLs');
  await noKeyAnywhere(job);
});

test('remove background is synchronous: done in one dispatch, from the documented `url` field', async () => {
  const u = await mkUser();
  const img = await mkImage(u);
  const op = await mkRoute('remove-background', SCHEMAS.bg);
  handler = () => ({ status: 200, headers: {}, data: { original: 'https://cdn-magnific.freepik.com/o.png', high_resolution: 'https://cdn-magnific.freepik.com/h.png', preview: 'https://cdn-magnific.freepik.com/p.png', url: 'https://cdn-magnific.freepik.com/h.png' } });
  const r = await submit(u, op.key, { image: img.uid });
  await worker.dispatch(new Date()); await worker.drain();
  const post = posts()[0];
  assert.equal(post.url, 'https://api.magnific.com/v1/ai/beta/remove-background');
  assert.match(post.data.image_url, /^https:\/\/mmb-bucket/);
  assert.equal(post.headers['Content-Type'], 'application/json');
  const job = await jobOf(r);
  assert.equal(job.status, 'done');
  assert.equal(job.provider_task_id, null);

  // form encoding is a route setting, in case the live call shows it is needed
  await AiOperationRoute.update({ fixed_params: { body_encoding: 'form' } }, { where: { operation_id: op.id } });
  calls.length = 0;
  await submit(u, op.key, { image: img.uid });
  await worker.dispatch(new Date()); await worker.drain();
  assert.equal(posts()[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.match(posts()[0].data, /^image_url=https%3A%2F%2Fmmb-bucket/);
});

test('GPT image 2.5 with num_images 2: one request, two files, charged per image', async () => {
  const u = await mkUser();
  const op = await mkRoute('gpt-image-2-5', SCHEMAS.poster, { resolution: '1k' });
  await AiOperation.update({ price_rules: { units_from: 'num_images' } }, { where: { id: op.id } });
  handler = () => created('g-1');
  const r = await submit(u, op.key, { prompt: 'Diwali sale', num_images: 2 });
  assert.equal(r.body.data.credits_charged, 2);
  await worker.dispatch(new Date()); await worker.drain();
  assert.equal(posts()[0].data.num_images, 2);
  handler = () => completed('g-1', ['https://cdn.freepik.com/1.png', 'https://cdn.freepik.com/2.png']);
  await worker.poll(later(5000));
  assert.equal((await jobOf(r)).result.files.length, 2);
});

test('moderation in a 400 at submit: failed, refunded, not retried; in a FAILED task too', async () => {
  const u = await mkUser();
  const op = await mkRoute('nano-banana-pro', SCHEMAS.image, { resolution: '2K' });
  handler = () => ({ status: 400, headers: {}, data: { message: 'Request blocked by content moderation' } });
  const r = await submit(u, op.key, { prompt: 'something' });
  await worker.dispatch(new Date()); await worker.drain();
  let job = await jobOf(r);
  assert.equal(job.status, 'failed');
  assert.equal(job.error_code, 'MODERATION_BLOCKED');
  assert.equal(await used(u.id), 0);
  await worker.dispatch(later(60000)); await worker.drain();
  assert.equal(posts().length, 1, 'never sent again');

  handler = () => created('m-2');
  const r2 = await submit(u, op.key, { prompt: 'other' });
  await worker.dispatch(new Date()); await worker.drain();
  handler = () => ({ status: 200, headers: {}, data: { data: { task_id: 'm-2', status: 'FAILED', error: 'NSFW content detected' } } });
  await worker.poll(later(5000));
  job = await jobOf(r2);
  assert.equal(job.error_code, 'MODERATION_BLOCKED');
  assert.ok(job.refunded_at);
});

test('a 500 at submit may have started a billed task: unknown, never resent', async () => {
  const u = await mkUser();
  const op = await mkRoute('nano-banana-pro', SCHEMAS.image);
  handler = () => ({ status: 500, headers: {}, data: { message: 'internal error' } });
  const r = await submit(u, op.key, { prompt: 'x' });
  await worker.dispatch(new Date()); await worker.drain();
  assert.equal((await jobOf(r)).status, 'unknown');
  await worker.dispatch(later(120000)); await worker.drain();
  assert.equal(posts().length, 1);
});

test('a rejected key trips the provider: jobs wait instead of retrying into 401s, new requests are not charged', async () => {
  const u = await mkUser();
  const op = await mkRoute('nano-banana-pro', SCHEMAS.image);
  handler = () => ({ status: 401, headers: {}, data: { message: 'Unauthorized' } });
  const r = await submit(u, op.key, { prompt: 'x' });
  await worker.dispatch(new Date()); await worker.drain();

  const job = await jobOf(r);
  assert.equal(job.status, 'queued');
  assert.ok(job.next_attempt_at.getTime() > Date.now() + 4 * 60 * 1000, 'waits out the trip');
  assert.equal(routing.tripReason(provider.id), 'auth_failed');
  assert.equal((await AiJobAttempt.findOne({ where: { job_id: job.id } })).error_code, 'AUTH_FAILED');

  const before = await used(u.id);
  const refused = await submit(u, op.key, { prompt: 'y' });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'AI_UNAVAILABLE');
  assert.equal(await used(u.id), before, 'nothing charged while the provider is tripped');

  const health = await h.request('GET', `${P}/admin/ai/health`, { token: admin });
  assert.equal(health.body.data.providers.find((p) => p.key === 'magnific').unavailable_reason, 'auth_failed');

  routing.clearTrips();
  await job.update({ next_attempt_at: new Date() });
  handler = () => created('after-fix');
  await worker.dispatch(new Date()); await worker.drain();
  assert.equal((await jobOf(r)).status, 'processing', 'tried again once the trip is over');
  await noKeyAnywhere(job);
});

test('an empty Magnific balance trips the provider as out_of_credits', async () => {
  const u = await mkUser();
  const op = await mkRoute('nano-banana-pro', SCHEMAS.image);
  handler = () => ({ status: 402, headers: {}, data: { message: 'Payment required' } });
  await submit(u, op.key, { prompt: 'x' });
  await worker.dispatch(new Date()); await worker.drain();
  assert.equal(routing.tripReason(provider.id), 'out_of_credits');
});

test('the callback URL is sent only when a public base URL is configured', async () => {
  process.env.AI_PUBLIC_WEBHOOK_BASE_URL = 'https://api.staging.example.com/';
  try {
    const u = await mkUser();
    const op = await mkRoute('nano-banana-pro', SCHEMAS.image);
    handler = () => created('cb-1');
    await submit(u, op.key, { prompt: 'x' });
    await worker.dispatch(new Date()); await worker.drain();
    assert.equal(posts()[0].data.webhook_url, 'https://api.staging.example.com/api/v1/webhooks/ai/magnific');
  } finally { delete process.env.AI_PUBLIC_WEBHOOK_BASE_URL; }
});

// ---------- webhooks ----------

function signed(body, { secretKey, id = `msg_${uuid()}`, ts = Math.floor(Date.now() / 1000) } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secretKey).update(Buffer.concat([Buffer.from(`${id}.${ts}.`), raw])).digest('base64');
  return { raw, headers: { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` } };
}

test('webhook signatures: raw and whsec_ secrets both verify; tampering, old timestamps and other secrets do not', () => {
  const body = { data: { task_id: 't', status: 'COMPLETED' } };
  const decoded = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const v = (s, secrets = [WEBHOOK_SECRET], settings = {}) => magnific.verifyWebhook({ rawBody: s.raw, headers: s.headers, secrets, provider: { settings } });

  assert.equal(v(signed(body, { secretKey: decoded })), true, 'PHP style: base64-decoded secret');
  assert.equal(v(signed(body, { secretKey: Buffer.from(WEBHOOK_SECRET) })), true, 'JS/Python style: the secret as typed');
  assert.equal(v(signed(body, { secretKey: decoded }), [WEBHOOK_SECRET], { webhook_secret_encoding: 'raw' }), false, 'pinned to raw, the decoded form is refused');

  const ok = signed(body, { secretKey: decoded });
  ok.headers['webhook-signature'] = `v1,AAAA v1,${ok.headers['webhook-signature'].slice(3)}`;
  assert.equal(v(ok), true, 'any of several signatures in the header');

  const tampered = signed(body, { secretKey: decoded });
  tampered.raw = Buffer.from(JSON.stringify({ data: { task_id: 't', status: 'FAILED' } }));
  assert.equal(v(tampered), false);
  assert.equal(v(signed(body, { secretKey: decoded, ts: Math.floor(Date.now() / 1000) - 600 })), false, 'a 10-minute-old delivery is a replay');
  assert.equal(v(signed(body, { secretKey: 'someone-else' })), false);
});

test('a signed COMPLETED webhook finishes the job through the real endpoint; a bad one is 401', async () => {
  const u = await mkUser();
  const op = await mkRoute('nano-banana-pro', SCHEMAS.image);
  handler = () => created('wh-1');
  const r = await submit(u, op.key, { prompt: 'x' });
  await worker.dispatch(new Date()); await worker.drain();

  const decoded = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const s = signed({ data: { task_id: 'wh-1', status: 'COMPLETED', generated: ['https://cdn-magnific.freepik.com/wh.png'] } }, { secretKey: decoded });
  const bad = await h.request('POST', `${P}/webhooks/ai/magnific`, { body: s.raw, headers: { ...s.headers, 'webhook-signature': 'v1,Zm9v' } });
  assert.equal(bad.status, 401);
  const ok = await h.request('POST', `${P}/webhooks/ai/magnific`, { body: s.raw, headers: s.headers });
  assert.equal(ok.status, 200);
  await aiJobs.drain();
  assert.equal((await jobOf(r)).status, 'done');
});

// ---------- capture, admin, verify ----------

test('capture mode keeps the raw response on the attempt — only when switched on, and never the key', async () => {
  const u = await mkUser();
  const op = await mkRoute('nano-banana-pro', SCHEMAS.image);
  handler = () => created('cap-1');
  const r1 = await submit(u, op.key, { prompt: 'x' });
  await worker.dispatch(new Date()); await worker.drain();
  assert.equal((await AiJobAttempt.findOne({ where: { job_id: (await jobOf(r1)).id } })).response_excerpt, null, 'off by default');

  await provider.update({ settings: { ...(provider.settings || {}), capture_responses: true } });
  try {
    handler = () => created('cap-2');
    const r2 = await submit(u, op.key, { prompt: 'y' });
    await worker.dispatch(new Date()); await worker.drain();
    const job = await jobOf(r2);
    const att = await AiJobAttempt.findOne({ where: { job_id: job.id } });
    assert.match(att.response_excerpt, /cap-2/);
    handler = () => completed('cap-2', ['https://cdn.freepik.com/c.png']);
    await worker.poll(later(5000));
    assert.match((await AiJobAttempt.findOne({ where: { job_id: job.id } })).response_excerpt, /\[status .*COMPLETED/);
    await noKeyAnywhere(job);
  } finally {
    await provider.update({ settings: { webhook_secret_encoding: 'auto', capture_responses: false } });
  }
});

test('admin: routes are checked by the adapter, and a single-image model cannot serve a multi-image operation', async () => {
  const op = await mkRoute('nano-banana-pro', SCHEMAS.image);
  const post = (body) => h.request('POST', `${P}/admin/ai/routes`, { token: admin, body: { operation_id: op.id, provider_id: provider.id, provider_units: 75, ...body } });
  assert.equal((await post({ model: 'imagen-4' })).status, 400);
  assert.equal((await post({ model: 'nano-banana-pro', fixed_params: { resolution: '8K' } })).status, 400);

  const multi = await mkRoute('gpt-image-2-5', SCHEMAS.poster);   // num_images up to 4
  const r = await h.request('POST', `${P}/admin/ai/routes`, { token: admin, body: { operation_id: multi.id, provider_id: provider.id, model: 'nano-banana-pro', provider_units: 75 } });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.body), /at most 1 image/);

  // …and the other direction: raising num_images past an existing route's model.
  const raise = await h.request('PATCH', `${P}/admin/ai/operations/${op.uid}`, { token: admin, body: { input_schema: { fields: { prompt: { type: 'string', required: true }, num_images: { type: 'integer', min: 1, max: 4 } } } } });
  assert.equal(raise.status, 400);
  assert.match(JSON.stringify(raise.body), /more than route/);

  const off = await h.request('PATCH', `${P}/admin/ai/providers/${provider.uid}`, { token: admin, body: { base_url: 'https://evil.example.com' }, headers: { 'X-Admin-Password': 'Admin@123' } });
  assert.equal(off.status, 400, 'base_url must stay on a Magnific host');
});

test('admin verify uses the free creations endpoint: 200 is valid, 401 reports AUTH_FAILED', async () => {
  const cred = await AiProviderCredential.findOne({ where: { provider_id: provider.id, kind: 'api_key', status: 'active' } });
  handler = (opts) => {
    assert.equal(opts.url, 'https://api.magnific.com/v1/creations/recent?per_page=1');
    assert.equal(opts.method, 'GET');
    return { status: 200, headers: {}, data: { data: [] } };
  };
  const ok = await h.request('POST', `${P}/admin/ai/providers/${provider.uid}/credentials/${cred.uid}/verify`, { token: admin, body: {} });
  assert.equal(ok.body.data.ok, true);

  handler = () => ({ status: 401, headers: {}, data: { message: 'Invalid API key' } });
  const bad = await h.request('POST', `${P}/admin/ai/providers/${provider.uid}/credentials/${cred.uid}/verify`, { token: admin, body: {} });
  assert.equal(bad.body.data.ok, false);
  assert.equal(bad.body.data.code, 'AUTH_FAILED');
  assert.ok(!JSON.stringify(bad.body).includes(API_KEY));
});

test('downloads refuse hosts outside Magnific/Freepik — a result URL cannot make us fetch anything else', async () => {
  const u = await mkUser();
  const op = await mkRoute('nano-banana-pro', SCHEMAS.image);
  handler = () => created('evil-1');
  const r = await submit(u, op.key, { prompt: 'x' });
  await worker.dispatch(new Date()); await worker.drain();
  handler = () => completed('evil-1', ['https://169.254.169.254/latest/meta-data']);
  await worker.poll(later(5000));
  const job = await jobOf(r);
  assert.equal(job.status, 'failed', 'the copy is refused, so the job fails and refunds');
  assert.ok(job.refunded_at);
  assert.ok(!calls.some((c) => c.method === 'DOWNLOAD' && c.url.includes('169.254')));
  assert.ok(ProviderError);
});
