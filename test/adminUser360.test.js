// Admin "User 360" read APIs (src/services/adminUser360.service.js): the users
// list filters + current_plan, the detail extras, and the per-user subscription,
// payment, business, project and invoice views.
//
// Every row is created here with fresh random identifiers (the test DB persists
// between runs — never rely on seeder ids) and removed afterwards.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Op } = require('sequelize');
const h = require('./helpers');

const { models } = h;
const {
  User, UserBillingDetail, UserSubscription, Payment, Plan, Business, Project, ProjectExport, ActivityLog,
  UserQuotaUsage, UserQuotaCounter, UserNotification, FeatureType,
} = models;
const P = '/api/v1';

const SUPER   = h.adminToken(['*']);
const USERS   = h.adminToken(['users.read']);              // no billing.read
const BILLING = h.adminToken(['users.read', 'billing.read']);
const CONTENT = h.adminToken(['templates.*', 'categories.*']);

const get = (path, token) => h.request('GET', `${P}${path}`, { token });
const rnd = () => crypto.randomBytes(4).toString('hex');
const phone = () => `+919${crypto.randomInt(100000000, 999999999)}`;

const track = { users: [] };
let startLogId = 0;
let paid, free, expired;   // users
let paidSub, okPayment, failedPayment, business, project;

before(async () => {
  await models.sequelize.authenticate();
  await h.start();
  startLogId = (await ActivityLog.max('id')) || 0;

  const plan = await Plan.findOne({ where: { plan_type: 'subscription' }, order: [['id', 'ASC']] });
  assert.ok(plan, 'test DB needs a subscription plan');
  const tag = rnd();

  const mk = async (attrs) => {
    const u = await User.create({ ...attrs, name: `U360 ${tag} ${attrs.name}`, phone: phone(), password_hash: 'never-returned' });
    track.users.push(u.id);
    return u;
  };
  paid    = await mk({ name: 'paid', account_type: 'business' });
  free    = await mk({ name: 'free', account_type: 'personal' });
  expired = await mk({ name: 'expired', account_type: 'personal', is_active: 0 });

  const now = Date.now();
  paidSub = await UserSubscription.create({
    user_id: paid.id, plan_id: plan.id, sub_type: 'regular', status: 'active',
    starts_at: new Date(now - 86400000), ends_at: new Date(now + 29 * 86400000), auto_renew: 1, amount_paid: 299,
  });
  await UserSubscription.create({
    user_id: paid.id, plan_id: plan.id, sub_type: 'regular', status: 'pending',
    starts_at: new Date(now), ends_at: new Date(now + 30 * 86400000), auto_renew: 0, amount_paid: 0,
  });
  await UserSubscription.create({
    user_id: expired.id, plan_id: plan.id, sub_type: 'regular', status: 'expired',
    starts_at: new Date(now - 60 * 86400000), ends_at: new Date(now - 30 * 86400000), auto_renew: 0, amount_paid: 299,
  });
  // An abandoned checkout does not make a "free" user "expired".
  await UserSubscription.create({
    user_id: free.id, plan_id: plan.id, sub_type: 'regular', status: 'pending',
    starts_at: new Date(now), ends_at: new Date(now + 30 * 86400000), auto_renew: 0, amount_paid: 0,
  });

  okPayment = await Payment.create({
    user_id: paid.id, subscription_id: paidSub.id, order_type: 'subscription', purchase_type: 'subscription',
    amount: 352.82, amount_before_tax: 299, gst_amount: 53.82, status: 'success',
    razorpay_order_id: `order_${tag}`, razorpay_payment_id: `pay_${tag}`, razorpay_signature: 'SECRET-SIGNATURE',
    invoice_number: `TEST/U360/${tag}`, paid_at: new Date(),
  });
  failedPayment = await Payment.create({
    user_id: paid.id, order_type: 'one_time', purchase_type: 'quota_pack',
    amount: 118, amount_before_tax: 100, gst_amount: 18, status: 'failed', failure_reason: 'Declined',
  });

  await UserBillingDetail.create({
    user_id: paid.id, billing_name: 'U360 Traders', gstin: '29ABCDE1234F1Z5',
    billing_address: '1 Test Road', billing_state: 'Karnataka', billing_pincode: '560001',
  });

  business = await Business.create({ user_id: paid.id, name: `U360 Biz ${tag}` });
  project  = await Project.create({ user_id: paid.id, business_id: business.id, name: `U360 Design ${tag}` });
  await ProjectExport.bulkCreate([
    { project_id: project.id, user_id: paid.id, export_type: 'download', status: 'success' },
    { project_id: project.id, user_id: paid.id, export_type: 'download', status: 'success' },
    { project_id: project.id, user_id: paid.id, export_type: 'share', platform: 'whatsapp', status: 'success' },
  ]);

  await ActivityLog.bulkCreate([
    { actor_type: 'user', actor_id: paid.id, entity_type: 'project', entity_id: project.id, action: 'u360.self' },
    { actor_type: 'admin', actor_id: 1, entity_type: 'user', entity_id: paid.id, action: 'u360.on_user' },
  ]);
});

after(async () => {
  if (track.users.length) {
    const ids = track.users;
    await UserNotification.destroy({ where: { user_id: ids } });
    await UserQuotaCounter.destroy({ where: { user_id: ids } });
    await UserQuotaUsage.destroy({ where: { user_id: ids } });
    await ProjectExport.destroy({ where: { user_id: ids } });
    await Project.destroy({ where: { user_id: ids } });
    await Business.destroy({ where: { user_id: ids } });
    await Payment.destroy({ where: { user_id: ids } });
    await UserSubscription.destroy({ where: { user_id: ids } });
    await UserBillingDetail.destroy({ where: { user_id: ids } });
    await User.destroy({ where: { id: ids } });
  }
  await ActivityLog.destroy({ where: { id: { [Op.gt]: startLogId } } });
  await h.stop();
  await models.sequelize.close();
});

const uids = (res) => res.body.data.map((r) => r.uid);

// ---- users list ----

test('users list: current_plan per row, no password_hash', async () => {
  const res = await get(`/admin/users?search=${encodeURIComponent(paid.name)}`, USERS);
  assert.equal(res.status, 200);
  const row = res.body.data.find((r) => r.uid === paid.uid);
  assert.ok(row);
  assert.equal(row.password_hash, undefined);
  assert.equal(row.current_plan.status, 'active');
  assert.equal(row.current_plan.sub_type, 'regular');
  assert.equal(row.current_plan.auto_renew, true);
});

test('users list: plan_state, account_type and is_active filters', async () => {
  const tag = paid.name.split(' ')[1];
  const q = (s) => get(`/admin/users?search=U360%20${tag}&${s}`, USERS);

  assert.deepEqual(uids(await q('plan_state=paid')), [paid.uid]);
  assert.deepEqual(uids(await q('plan_state=free')), [free.uid]);
  assert.deepEqual(uids(await q('plan_state=expired')), [expired.uid]);
  assert.deepEqual(uids(await q('plan_state=trial')), []);
  assert.deepEqual(uids(await q('account_type=business')), [paid.uid]);
  assert.deepEqual(uids(await q('is_active=0')), [expired.uid]);

  const freeRow = (await q('plan_state=free')).body.data[0];
  assert.equal(freeRow.current_plan, null);
  assert.equal((await q('plan_state=gold')).status, 400);
});

// ---- user detail ----

test('user detail: counts + has_active_subscription; billing_details only with billing.read', async () => {
  const plain = await get(`/admin/users/${paid.uid}`, USERS);
  assert.equal(plain.status, 200);
  assert.equal(plain.body.data.password_hash, undefined);
  assert.equal(plain.body.data.has_active_subscription, true);
  assert.deepEqual(plain.body.data.counts, { projects: 1, downloads: 2, shares: 1, ai_jobs: 0, businesses: 1, active_sessions: 0 });
  assert.ok(!('billing_details' in plain.body.data));

  const withBilling = await get(`/admin/users/${paid.uid}`, BILLING);
  assert.equal(withBilling.body.data.billing_details.gstin, '29ABCDE1234F1Z5');

  const freeDetail = await get(`/admin/users/${free.uid}`, BILLING);
  assert.equal(freeDetail.body.data.has_active_subscription, false);
  assert.equal(freeDetail.body.data.billing_details, null);
});

// ---- permissions ----

test('commerce views need billing.read; content views need users.read', async () => {
  for (const path of [`/admin/users/${paid.uid}/subscription`, `/admin/users/${paid.uid}/subscriptions`,
    `/admin/users/${paid.uid}/payments`, `/admin/payments/${okPayment.uid}/document`]) {
    assert.equal((await get(path, USERS)).status, 403, path);
  }
  for (const path of [`/admin/users/${paid.uid}/businesses`, `/admin/users/${paid.uid}/projects`]) {
    assert.equal((await get(path, CONTENT)).status, 403, path);
    assert.equal((await get(path, USERS)).status, 200, path);
  }
});

test('unknown user uid is a 404', async () => {
  const ghost = crypto.randomUUID();
  for (const s of ['subscription', 'subscriptions', 'payments', 'businesses', 'projects']) {
    assert.equal((await get(`/admin/users/${ghost}/${s}`, SUPER)).status, 404, s);
  }
});

// ---- subscription views ----

test('subscription: same shape as /subscriptions/me', async () => {
  const res = await get(`/admin/users/${paid.uid}/subscription`, BILLING);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.has_active_subscription, true);
  assert.equal(res.body.data.subscription.uid, paidSub.uid);
  assert.ok(Array.isArray(res.body.data.features));

  const f = await get(`/admin/users/${free.uid}/subscription`, BILLING);
  assert.equal(f.body.data.has_active_subscription, false);
  assert.equal(f.body.data.subscription, null);
});

test('subscription view is read-only: an ended period is not rolled over and nobody is notified', async () => {
  const downloads = await FeatureType.findOne({ where: { key: 'downloads' } });
  assert.ok(downloads, 'test DB needs the downloads feature type');
  // A usage period that ended long ago, with a stale tally in it.
  await UserQuotaUsage.create({ user_id: paid.id, period_start: '2026-01-01', period_end: '2026-02-01' });
  await UserQuotaCounter.create({ user_id: paid.id, feature_type_id: downloads.id, used: 5 });

  const res = await get(`/admin/users/${paid.uid}/subscription`, BILLING);
  assert.equal(res.status, 200);
  // Reported as the user WILL see it once the rollover runs: current window, stale tally at 0.
  assert.notEqual(res.body.data.period.end, '2026-02-01');
  assert.ok(new Date(res.body.data.period.end) > new Date());
  const dl = res.body.data.features.find((f) => f.key === 'downloads');
  assert.ok(dl, 'the subscription plan should declare downloads');
  assert.equal(dl.used, 0);

  // ...but nothing in the database moved, and no notification went out.
  await new Promise((r) => setTimeout(r, 300));   // notify() is fire-and-forget
  const usage = await UserQuotaUsage.findOne({ where: { user_id: paid.id } });
  assert.equal(usage.period_end, '2026-02-01');
  const counter = await UserQuotaCounter.findOne({ where: { user_id: paid.id, feature_type_id: downloads.id } });
  assert.equal(Number(counter.used), 5);
  assert.equal(await UserNotification.count({ where: { user_id: paid.id } }), 0);
});

test('subscriptions: every status, newest first, filterable', async () => {
  const res = await get(`/admin/users/${paid.uid}/subscriptions`, BILLING);
  assert.equal(res.status, 200);
  assert.equal(res.body.meta.total, 2);
  assert.deepEqual(res.body.data.map((s) => s.status), ['pending', 'active']);
  assert.ok(res.body.data[1].Plan.name);

  const active = await get(`/admin/users/${paid.uid}/subscriptions?status=active`, BILLING);
  assert.deepEqual(uids(active), [paidSub.uid]);
  assert.equal((await get(`/admin/users/${paid.uid}/subscriptions?status=nope`, BILLING)).status, 400);
});

// ---- payments ----

test('payments: paged, described, filterable, never the signature', async () => {
  const res = await get(`/admin/users/${paid.uid}/payments`, BILLING);
  assert.equal(res.status, 200);
  assert.equal(res.body.meta.total, 2);
  assert.ok(!JSON.stringify(res.body).includes('SECRET-SIGNATURE'));

  const ok = res.body.data.find((p) => p.uid === okPayment.uid);
  assert.equal(ok.has_invoice, true);
  assert.equal(ok.status, 'success');
  assert.equal(ok.razorpay_signature, undefined);
  assert.match(ok.description, /Plan/);
  const bad = res.body.data.find((p) => p.uid === failedPayment.uid);
  assert.equal(bad.has_invoice, false);
  assert.equal(bad.display_status, 'failed');

  assert.deepEqual(uids(await get(`/admin/users/${paid.uid}/payments?status=success`, BILLING)), [okPayment.uid]);
  assert.deepEqual(uids(await get(`/admin/users/${paid.uid}/payments?purchase_type=quota_pack`, BILLING)), [failedPayment.uid]);
  assert.equal(uids(await get(`/admin/users/${paid.uid}/payments?limit=1&offset=1`, BILLING)).length, 1);
  assert.equal((await get(`/admin/users/${paid.uid}/payments?purchase_type=nope`, BILLING)).status, 400);
});

test('payment document: admin can open any user\'s invoice; unpaid is 409', async () => {
  const res = await get(`/admin/payments/${okPayment.uid}/document?type=invoice`, BILLING);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.ok(String(res.body).includes(okPayment.invoice_number));
  assert.ok(String(res.body).includes('U360 Traders'));   // buyer = the payment's own user

  assert.equal((await get(`/admin/payments/${okPayment.uid}/document?type=receipt`, BILLING)).status, 200);
  assert.equal((await get(`/admin/payments/${failedPayment.uid}/document`, BILLING)).status, 409);
  assert.equal((await get(`/admin/payments/${crypto.randomUUID()}/document`, BILLING)).status, 404);
});

// ---- businesses / projects ----

test('businesses and projects', async () => {
  const b = await get(`/admin/users/${paid.uid}/businesses`, USERS);
  assert.deepEqual(uids(b), [business.uid]);
  assert.equal(b.body.data[0].id, undefined);
  assert.deepEqual(b.body.data[0].variants, []);

  const p = await get(`/admin/users/${paid.uid}/projects`, USERS);
  assert.equal(p.body.meta.total, 1);
  assert.equal(p.body.data[0].export_count, 3);
  assert.equal(p.body.data[0].Business.uid, business.uid);
  assert.equal(p.body.data[0].content, undefined);
});

// ---- activity ----

test('activity-logs: user_uid with actor / subject / both scopes', async () => {
  const base = `/admin/activity-logs?user_uid=${paid.uid}`;
  const actions = async (scope) => (await get(`${base}${scope ? `&user_scope=${scope}` : ''}`, SUPER)).body.data.map((r) => r.action);

  assert.deepEqual(await actions('actor'), ['u360.self']);
  assert.deepEqual(await actions('subject'), ['u360.on_user']);
  assert.deepEqual((await actions()).sort(), ['u360.on_user', 'u360.self']);
  assert.equal((await get(`/admin/activity-logs?user_uid=${crypto.randomUUID()}`, SUPER)).status, 404);
  assert.equal((await get(`${base}&user_scope=all`, SUPER)).status, 400);
});
