// /admin/ai: who may touch it, write-only credentials with password step-up,
// catalogue write gates, provider cost from purchases, job resolution, the margin
// report, health and master-key rotation. No network: the only adapter is `fake`.
const crypto = require('node:crypto');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { v4: uuid } = require('uuid');

process.env.AI_SECRETS_MASTER_KEY = crypto.randomBytes(32).toString('base64');
process.env.AI_SECRETS_MASTER_KEY_VERSION = '1';

const h = require('./helpers');
const { models } = h;
const { AdminUser, AiProvider, AiProviderCredential, AiOperation, AiOperationRoute, AiJob, ActivityLog,
  ProviderCreditPurchase, User, UserSubscription, Plan, PlanFeature, FeatureType, AppSetting, UserUpload } = models;
const credentialStore = require('../src/ai/credentialStore');
const secretBox = require('../src/utils/secretBox');
const reauth = require('../src/middlewares/requireAdminReauth');
const aiJobs = require('../src/services/aiJob.service');

const P = '/api/v1/admin/ai';
const PASSWORD = 'Admin@123';      // the seeded super admin (baseline seeder)
const track = { ops: [], creds: [], purchases: [], users: [], plans: [], jobs: [] };
let fake;
let admin;          // super_admin token
let contentAdmin;   // a wildcard role WITHOUT the ai_* domains
let original;       // fake provider's settings, restored after
let startLogId = 0;
let seq = 0;

before(async () => {
  await models.sequelize.authenticate();
  await h.start();
  const row = await AdminUser.findOne({ where: { email: 'admin@makemybrand.com' } });
  admin = h.adminToken(['*'], row.id);
  contentAdmin = h.adminToken(['templates.*', 'categories.*', 'assets.*'], row.id);
  fake = await AiProvider.findOne({ where: { key: 'fake' } });
  original = fake.toJSON();
  startLogId = (await ActivityLog.max('id')) || 0;
});

after(async () => {
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
  if (track.creds.length) await AiProviderCredential.destroy({ where: { id: track.creds } });
  if (track.purchases.length) await ProviderCreditPurchase.destroy({ where: { id: track.purchases } });
  if (track.plans.length) {
    await PlanFeature.destroy({ where: { plan_id: track.plans } });
    await Plan.destroy({ where: { id: track.plans } });
  }
  await AiProvider.update({
    rate_limit_rpm: original.rate_limit_rpm, base_url: original.base_url,
    cost_per_unit_inr: original.cost_per_unit_inr, cost_updated_at: original.cost_updated_at,
  }, { where: { id: fake.id } });
  await ActivityLog.destroy({ where: { id: { [require('sequelize').Op.gt]: startLogId } } });
  credentialStore.clearCache();
  await h.stop();
  await models.sequelize.close();
});

beforeEach(() => { reauth._resetFailures(); credentialStore.clearCache(); });

const req = (method, path, { token = admin, body, password } = {}) => h.request(method, `${P}${path}`, {
  token, body, headers: password ? { 'X-Admin-Password': password } : {},
});

async function mkOp(over = {}) {
  const op = await AiOperation.create({
    key: `tst.adm.${Date.now()}.${seq += 1}`, label: 'TST admin op', credits: 4, unit: 'image',
    ledger_source: 'image_generation', is_active: true,
    input_schema: { fields: { prompt: { type: 'string', required: true } } }, ...over,
  });
  track.ops.push(op.id);
  const route = await AiOperationRoute.create({ operation_id: op.id, provider_id: fake.id, model: 'fake-image', fixed_params: { mode: 'async' }, provider_units: 75 });
  return { op, route };
}

// ---------- access ----------

test('the ai_* domains are super_admin only: a wildcard content role gets 403 everywhere', async () => {
  for (const path of ['/providers', '/operations', '/routes', '/provider-purchases', '/jobs', '/reports/margin', '/health', `/providers/${fake.uid}/credentials`]) {
    const r = await req('GET', path, { token: contentAdmin });
    assert.equal(r.status, 403, `${path} → ${r.status}`);
  }
  assert.equal((await h.request('GET', `${P}/providers`, { token: h.userTokenFor(1) })).status, 403, 'an app user is not an admin');
});

// ---------- providers ----------

test('providers: key must be a known adapter and never changes; base_url needs re-auth and an allowed host; cost is read-only', async () => {
  const unknown = await req('POST', '/providers', { body: { key: 'acme_ai', name: 'Acme' } });
  assert.equal(unknown.status, 400);
  assert.match(JSON.stringify(unknown.body), /no provider adapter named/);
  assert.equal((await req('POST', '/providers', { body: { key: 'fake', name: 'Dup' } })).status, 409);

  const rpm = await req('PATCH', `/providers/${fake.uid}`, { body: { rate_limit_rpm: 321 } });
  assert.equal(rpm.status, 200, 'a plain setting needs no re-auth');
  assert.equal(rpm.body.data.rate_limit_rpm, 321);

  const noPw = await req('PATCH', `/providers/${fake.uid}`, { body: { base_url: 'https://fake.invalid/v1' } });
  assert.equal(noPw.status, 403);
  assert.equal(noPw.body.error.code, 'REAUTH_REQUIRED');

  const evil = await req('PATCH', `/providers/${fake.uid}`, { body: { base_url: 'https://attacker.example.com' }, password: PASSWORD });
  assert.equal(evil.status, 400, 'a host the adapter does not declare is refused — our key would go there');

  const ok = await req('PATCH', `/providers/${fake.uid}`, { body: { base_url: 'https://fake.invalid/v1' }, password: PASSWORD });
  assert.equal(ok.status, 200);

  assert.equal((await req('PATCH', `/providers/${fake.uid}`, { body: { cost_per_unit_inr: 0.0001 } })).status, 400, 'cost is derived, not typed in');
  assert.equal((await req('PATCH', `/providers/${fake.uid}`, { body: { key: 'other' } })).status, 400);

  const del = await req('DELETE', `/providers/${fake.uid}`);
  assert.equal(del.status, 409, 'a provider with routes is disabled, never deleted');
});

// ---------- credentials ----------

test('credentials are write-only: password step-up, last4 only, never readable, audited without the value', async () => {
  const secret = `sk-test-${uuid()}`;
  const path = `/providers/${fake.uid}/credentials`;

  const none = await req('POST', path, { body: { kind: 'api_key', value: secret } });
  assert.equal(none.body.error.code, 'REAUTH_REQUIRED');
  const wrong = await req('POST', path, { body: { kind: 'api_key', value: secret }, password: 'nope' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'REAUTH_FAILED', '403, not 401 — a typo must not log the admin out');

  const created = await req('POST', path, { body: { kind: 'api_key', value: secret }, password: PASSWORD });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const cred = created.body.data;
  track.creds.push((await AiProviderCredential.findOne({ where: { uid: cred.uid } })).id);
  assert.equal(cred.status, 'pending');
  assert.equal(cred.last4, secret.slice(-4));

  const list = await req('GET', path);
  const dump = JSON.stringify(list.body);
  assert.ok(!dump.includes(secret), 'the value never comes back');
  assert.ok(!/ciphertext|auth_tag|"iv"/.test(dump), 'nor its encrypted parts');

  const verify = await req('POST', `${path}/${cred.uid}/verify`);
  assert.equal(verify.status, 200);
  assert.equal(verify.body.data.ok, true);

  assert.equal((await req('POST', `${path}/${cred.uid}/activate`)).body.error.code, 'REAUTH_REQUIRED');
  const act = await req('POST', `${path}/${cred.uid}/activate`, { password: PASSWORD });
  assert.equal(act.status, 200);
  assert.equal(act.body.data.status, 'active');
  assert.equal(await credentialStore.apiKey(fake), secret, 'it is what the adapter now gets');
  assert.equal((await req('POST', `${path}/${cred.uid}/activate`, { password: PASSWORD })).status, 409, 'only pending can be activated');

  const ret = await req('POST', `${path}/${cred.uid}/retire`, { password: PASSWORD });
  assert.equal(ret.body.data.status, 'retired');
  assert.equal(await credentialStore.apiKey(fake), null);

  const logs = await ActivityLog.findAll({ where: { action: ['ai_credential.created', 'ai_credential.activated', 'ai_credential.retired'], id: { [require('sequelize').Op.gt]: startLogId } } });
  assert.ok(logs.length >= 3);
  assert.ok(!JSON.stringify(logs.map((l) => l.metadata)).includes(secret), 'the audit trail never holds the value');
});

test('re-auth locks after five wrong passwords', async () => {
  const path = `/providers/${fake.uid}/credentials`;
  for (let i = 0; i < 5; i += 1) await req('POST', path, { body: { kind: 'api_key', value: 'x'.repeat(10) }, password: 'bad' });
  const locked = await req('POST', path, { body: { kind: 'api_key', value: 'x'.repeat(10) }, password: PASSWORD });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'REAUTH_LOCKED');
});

test('no master key on the server: credentials are refused with a clear 409, not stored in the clear', async () => {
  const saved = process.env.AI_SECRETS_MASTER_KEY;
  delete process.env.AI_SECRETS_MASTER_KEY;
  try {
    const r = await req('POST', `/providers/${fake.uid}/credentials`, { body: { kind: 'api_key', value: 'sk-nokey-123' }, password: PASSWORD });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'AI_MASTER_KEY_MISSING');
  } finally { process.env.AI_SECRETS_MASTER_KEY = saved; }
});

// ---------- operations + routes ----------

test('operations: ledger source, input schema and price rules are checked; key is permanent; reorder writes sort_order', async () => {
  const key = `tst.adm.${Date.now()}.op`;
  const base = { key, label: 'Poster', credits: 2, input_schema: { fields: { prompt: { type: 'string', required: true }, quality: { type: 'enum', values: ['low', 'high'] } } } };

  assert.equal((await req('POST', '/operations', { body: { ...base, ledger_source: 'download' } })).status, 400, 'not an AI-credits source');
  const gap = await req('POST', '/operations', { body: { ...base, price_rules: { multipliers: { quality: { low: 1 } } } } });
  assert.equal(gap.status, 400);
  assert.match(JSON.stringify(gap.body), /no price for high/);

  const ok = await req('POST', '/operations', { body: { ...base, price_rules: { multipliers: { quality: { low: 1, high: 2 } } } } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const op = await AiOperation.findOne({ where: { uid: ok.body.data.uid } });
  track.ops.push(op.id);

  assert.equal((await req('PATCH', `/operations/${op.uid}`, { body: { key: 'renamed' } })).status, 400);
  assert.equal((await req('PATCH', `/operations/${op.uid}`, { body: { credits: 3 } })).body.data.credits, 3);

  const route = await req('POST', '/routes', { body: { operation_id: op.id, provider_id: fake.id, model: 'fake-image', provider_units: 30, fixed_params: { mode: 'sync' } } });
  assert.equal(route.status, 201, JSON.stringify(route.body));
  assert.equal((await req('POST', '/routes', { body: { operation_id: op.id, provider_id: fake.id, model: '', provider_units: 1 } })).status, 400);
  assert.equal((await req('PATCH', `/routes/${route.body.data.uid}`, { body: { provider_id: 999 } })).status, 400, 'a route never moves provider');

  // Allowed plans: replaced as a whole; [] = every plan; an unknown plan is a 400.
  const planA = await Plan.create({ uid: uuid(), name: `TST AI Adm Plan A ${Date.now()}`, plan_type: 'subscription', status: 'active' });
  const planB = await Plan.create({ uid: uuid(), name: `TST AI Adm Plan B ${Date.now()}`, plan_type: 'subscription', status: 'active' });
  track.plans.push(planA.id, planB.id);
  assert.equal((await req('PATCH', `/operations/${op.uid}`, { body: { plan_ids: [999999999] } })).status, 400);
  assert.equal((await req('PATCH', `/operations/${op.uid}`, { body: { plan_ids: [planA.id, planB.id] } })).status, 200);
  assert.equal((await req('PATCH', `/operations/${op.uid}`, { body: { plan_ids: [planB.id] } })).status, 200);
  assert.equal((await req('PATCH', `/operations/${op.uid}`, { body: { is_premium_only: true } })).status, 400, 'the old flag is gone');

  const listed = await req('GET', '/operations');
  const mine = listed.body.data.find((o) => o.uid === op.uid);
  assert.equal(mine.routes.length, 1);
  assert.equal(mine.routes[0].provider.key, 'fake');
  assert.deepEqual(mine.plans.map((p) => p.uid), [planB.uid], 'the list was replaced, not appended to');
  await req('PATCH', `/operations/${op.uid}`, { body: { plan_ids: [] } });
  assert.equal((await models.AiOperationPlan.count({ where: { operation_id: op.id } })), 0, '[] = every plan');

  const { op: other } = await mkOp();
  const reorder = await req('PATCH', '/operations/reorder', { body: { ids: [other.uid, op.uid] } });
  assert.equal(reorder.status, 200);
  assert.equal((await AiOperation.findByPk(op.id)).sort_order, 1);

  assert.equal((await req('DELETE', `/operations/${op.uid}`)).status, 409, 'it has a route');
  assert.equal((await req('DELETE', `/routes/${route.body.data.uid}`)).status, 200, 'an unused route can go');
});

// ---------- purchases -> cost ----------

test('provider cost = Σ paid ÷ Σ credits over the last 12 months; past jobs keep their snapshot', async () => {
  const mk = async (body) => {
    const r = await req('POST', '/provider-purchases', { body: { provider_id: fake.id, ...body } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    track.purchases.push((await ProviderCreditPurchase.findOne({ where: { uid: r.body.data.uid } })).id);
    return r.body.data;
  };
  await mk({ purchased_at: new Date(Date.now() - 400 * 864e5).toISOString(), credits_received: 1000, amount_paid_inr: 1000 }); // too old
  await mk({ purchased_at: new Date().toISOString(), credits_received: 100000, amount_paid_inr: 7570 });
  await mk({ purchased_at: new Date().toISOString(), credits_received: 100000, amount_paid_inr: 8000, amount_foreign: 90, currency: 'usd' });
  let p = await AiProvider.findByPk(fake.id);
  assert.equal(Number(p.cost_per_unit_inr), 0.07785, '(7570 + 8000) / 200000 — the 400-day-old purchase is out of the window');

  // Deleting a purchase recomputes too.
  const last = await ProviderCreditPurchase.findByPk(track.purchases[2]);
  await req('DELETE', `/provider-purchases/${last.uid}`);
  p = await AiProvider.findByPk(fake.id);
  assert.equal(Number(p.cost_per_unit_inr), 0.0757);
});

test('postpaid provider: costed from settings.inr_per_unit until an invoice is recorded; no balance tracked', async () => {
  const balance = require('../src/ai/balance');
  // The google row seeded by migration 063 (disabled, postpaid, usd_cent).
  const g = await AiProvider.findOne({ where: { key: 'google' } });
  assert.ok(g, 'migration 063 seeds the google provider');
  const gOriginal = g.toJSON();
  assert.equal(g.cost_unit, 'usd_cent');
  assert.equal(g.status, 'disabled');
  const id = g.id;
  try {
    const badMode = await req('PATCH', `/providers/${g.uid}`, { body: { settings: { billing: 'monthly' } } });
    assert.equal(badMode.status, 400);
    const prepaidRate = await req('PATCH', `/providers/${g.uid}`, { body: { settings: { inr_per_unit: 0.9 } } });
    assert.equal(prepaidRate.status, 400, 'a typed-in rate is for postpaid providers only');

    const r = await req('PATCH', `/providers/${g.uid}`, { body: { settings: { billing: 'postpaid', inr_per_unit: 0.92 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(Number((await AiProvider.findByPk(id)).cost_per_unit_inr), 0.92, 'costed from the manual rate at once');

    const upd = await req('PATCH', `/providers/${g.uid}`, { body: { settings: { billing: 'postpaid', inr_per_unit: 0.95 } } });
    assert.equal(upd.status, 200);
    assert.equal(Number((await AiProvider.findByPk(id)).cost_per_unit_inr), 0.95);

    // An invoice, recorded as a purchase: 50,000 US cents billed, ₹46,000 paid -> ₹0.92 per cent.
    const inv = await req('POST', '/provider-purchases', { body: { provider_id: id, purchased_at: new Date().toISOString(), credits_received: 50000, amount_paid_inr: 46000 } });
    assert.equal(inv.status, 201);
    track.purchases.push((await ProviderCreditPurchase.findOne({ where: { uid: inv.body.data.uid } })).id);
    assert.equal(Number((await AiProvider.findByPk(id)).cost_per_unit_inr), 0.92, 'recorded invoices override the manual rate');

    assert.ok(!(await balance.balances()).some((b) => b.provider_id === id), 'postpaid: no prepaid balance to alert on');
    const health = await req('GET', '/health');
    assert.equal(health.body.data.providers.find((p) => p.key === 'google').billing, 'postpaid');
  } finally {
    await ProviderCreditPurchase.destroy({ where: { provider_id: id } });
    await AiProvider.update({ settings: gOriginal.settings, cost_per_unit_inr: gOriginal.cost_per_unit_inr, cost_updated_at: gOriginal.cost_updated_at }, { where: { id } });
  }
});

test('adapters: the keys a provider may have, which are taken, their hosts and model lists — super_admin only', async () => {
  const r = await req('GET', '/adapters');
  assert.equal(r.status, 200);
  const byKey = Object.fromEntries(r.body.data.map((a) => [a.key, a]));
  assert.deepEqual(Object.keys(byKey).sort(), ['fake', 'google', 'magnific'], 'fake is listed outside production');
  assert.equal(byKey.magnific.requires_api_key, true);
  assert.ok(byKey.magnific.models.includes('nano-banana-pro'));
  assert.ok(byKey.magnific.allowed_hosts.includes('api.magnific.com'));
  assert.equal(byKey.google.models, null, 'free text, checked on save');
  assert.equal(byKey.fake.requires_api_key, false);
  for (const a of r.body.data) {
    const row = await AiProvider.findOne({ where: { key: a.key } });
    assert.equal(a.in_use, Boolean(row), a.key);
    if (row) assert.equal(a.provider.uid, row.uid);
  }
  assert.equal((await req('GET', '/adapters', { token: contentAdmin })).status, 403);
});

// ---------- jobs ----------

async function meteredUser(credits = 10) {
  const aiFeature = await FeatureType.findOne({ where: { key: 'ai_credits' } });
  const plan = await Plan.create({ uid: uuid(), name: `TST AI Adm Plan ${Date.now()}${seq += 1}`, plan_type: 'subscription', status: 'inactive' });
  track.plans.push(plan.id);
  await PlanFeature.create({ plan_id: plan.id, feature_type_id: aiFeature.id, value: credits });
  const user = await User.create({ uid: uuid(), name: 'TST AI Adm', phone: `7${String((Date.now() + (seq += 11)) % 1000000000).padStart(9, '0')}` });
  track.users.push(user.id);
  await UserSubscription.create({ uid: uuid(), user_id: user.id, plan_id: plan.id, sub_type: 'regular', status: 'active', starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 1 });
  return user;
}

test('jobs: list with filters, detail with attempts, resolve refunds exactly once', async () => {
  const user = await meteredUser(10);
  const { op } = await mkOp({ credits: 3 });
  const { job } = await aiJobs.submit(user.id, op.key, { prompt: 'x' }, uuid());
  await job.update({ status: 'unknown' });

  const list = await req('GET', `/jobs?status=unknown&user_id=${user.id}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.meta.total, 1);
  assert.equal(list.body.data[0].uid, job.uid);
  assert.ok(!('provider_result' in list.body.data[0]));

  const detail = await req('GET', `/jobs/${job.uid}`);
  assert.ok(Array.isArray(detail.body.data.attempts));

  const counter = async () => Number((await models.UserQuotaCounter.findOne({ where: { user_id: user.id } })).used);
  assert.equal(await counter(), 3);
  const resolved = await req('POST', `/jobs/${job.uid}/resolve`, { body: { outcome: 'refund', note: 'Ticket 77' } });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.data.status, 'failed');
  assert.equal(resolved.body.data.refund_split.internal_code, 'ADMIN_RESOLVED');
  assert.equal(await counter(), 0, 'refunded');
  assert.equal((await req('POST', `/jobs/${job.uid}/resolve`, { body: { outcome: 'refund' } })).status, 409);
  assert.equal(await counter(), 0, 'and only once');
});

// ---------- margin report ----------

test('margin report: actuals from snapshotted costs, at-risk failed jobs, and a stressed projection flagged below target', async () => {
  const { op, route } = await mkOp({ credits: 4 });
  const base = {
    operation_id: op.id, operation_key: op.key, route_id: route.id, provider_id: fake.id, model: 'fake-image',
    provider_units: 75, cost_per_unit_inr: 0.0757, input_hash: '0'.repeat(64),
  };
  for (const [status, credits, sent] of [['done', 4, true], ['done', 4, true], ['failed', 4, true]]) {
    const j = await AiJob.create({ ...base, uid: uuid(), idempotency_key: uuid(), status, credits_charged: credits, provider_task_id: sent ? 'fake_x' : null });
    track.jobs.push(j.id);
  }

  const setting = await AppSetting.findOne({ where: { key: 'ai_credit_value_inr' } });
  const before = setting.value;
  await setting.update({ value: '1.5' });   // 4 credits = ₹6 per image vs ₹5.68 cost
  try {
    const r = await req('GET', '/reports/margin');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = r.body.data.actuals.find((x) => x.operation_key === op.key);
    assert.equal(a.jobs_done, 2);
    assert.equal(a.jobs_failed, 1);
    assert.equal(a.credits_sold, 8);
    assert.equal(a.revenue_inr, 12);
    assert.equal(a.cost_inr, 11.36);
    assert.equal(a.at_risk_inr, 5.68, 'a failed job that reached the provider may still have been billed');
    // From the unrounded cost (2 × 75 × 0.0757 = 11.355), not the displayed 11.36.
    assert.equal(a.margin_pct, Math.round(((12 - 11.355) / 12) * 10000) / 100);
    assert.equal(a.below_target, true, 'under the 50% target');

    const pr = r.body.data.projection.find((x) => x.route_uid === route.uid);
    assert.equal(pr.price_inr, 6);
    assert.equal(pr.cost_today_inr, 5.68);
    assert.equal(pr.cost_stressed_inr, 6.53, '15% weaker rupee');
    assert.ok(pr.margin_pct_stressed < 0, 'a loss once the rupee weakens');
    assert.equal(pr.below_target, true);
  } finally { await setting.update({ value: before }); }

  const blank = await req('GET', '/reports/margin');
  assert.ok(blank.body.data.warnings.some((w) => /ai_credit_value_inr is not set/.test(w)));
});

// ---------- health ----------

test('health: providers with why they are unusable, queue depth, worker view', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  const f = r.body.data.providers.find((p) => p.key === 'fake');
  assert.equal(f.unavailable_reason, null, 'the fake adapter needs no key');
  assert.equal(r.body.data.master_key_configured, true);
  assert.ok('queued' in r.body.data.queue);
  assert.ok('this_instance_is_leader' in r.body.data.worker);
});

// ---------- master-key rotation ----------

test('ai:rekey re-encrypts every credential under the new master key; old rows decrypt meanwhile', async () => {
  const oldKey = process.env.AI_SECRETS_MASTER_KEY;
  const cred = await credentialStore.addPending(fake, 'webhook_secret', 'whsec-rekey-0001');
  track.creds.push(cred.id);

  process.env.AI_SECRETS_PREVIOUS_MASTER_KEY = oldKey;
  process.env.AI_SECRETS_PREVIOUS_MASTER_KEY_VERSION = '1';
  process.env.AI_SECRETS_MASTER_KEY = crypto.randomBytes(32).toString('base64');
  process.env.AI_SECRETS_MASTER_KEY_VERSION = '2';
  try {
    assert.equal(await credentialStore.reveal(cred.id), 'whsec-rekey-0001', 'still readable with the previous key');
    const { rekeyAll } = require('../src/ai/rekey');
    const out = await rekeyAll({ log: () => {} });
    assert.ok(out.done >= 1);
    assert.equal(out.failed.length, 0);
    assert.equal((await AiProviderCredential.findByPk(cred.id)).master_key_version, 2);

    delete process.env.AI_SECRETS_PREVIOUS_MASTER_KEY;
    delete process.env.AI_SECRETS_PREVIOUS_MASTER_KEY_VERSION;
    assert.equal(await credentialStore.reveal(cred.id), 'whsec-rekey-0001', 'readable with the new key alone');
    assert.equal((await rekeyAll({ log: () => {} })).total, 0, 're-running finds nothing left');
  } finally {
    // Leave every row on version 1 again for the rest of the suite.
    process.env.AI_SECRETS_PREVIOUS_MASTER_KEY = process.env.AI_SECRETS_MASTER_KEY;
    process.env.AI_SECRETS_PREVIOUS_MASTER_KEY_VERSION = '2';
    process.env.AI_SECRETS_MASTER_KEY = oldKey;
    process.env.AI_SECRETS_MASTER_KEY_VERSION = '1';
    await require('../src/ai/rekey').rekeyAll({ log: () => {} });
    delete process.env.AI_SECRETS_PREVIOUS_MASTER_KEY;
    delete process.env.AI_SECRETS_PREVIOUS_MASTER_KEY_VERSION;
    assert.ok(secretBox.isConfigured());
  }
});
