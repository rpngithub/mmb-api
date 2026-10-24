// Admin dashboard widgets: the per-widget permission model, parameter validation,
// and each widget's numbers against rows seeded for the purpose.
//
// The test DB persists between runs and is shared with api.test.js, so nothing
// here asserts a global count. Range-scoped widgets are pointed at a window in
// 2001 that only this file writes into (rows are back-dated with a raw UPDATE),
// which makes their counts exact; snapshot widgets are checked by finding the rows
// this file created.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { v4: uuid } = require('uuid');
const h = require('./helpers');
const ist = require('../src/utils/istTime');
const dashboard = require('../src/services/dashboard.service');

const { models } = h;
const { sequelize } = models;
const P = '/api/v1';

const FROM = '2001-03-01';
const TO   = '2001-03-10';
const IN_RANGE = '2001-03-05 06:00:00';   // UTC; 11:30 IST on 2001-03-05

const track = { users: [], plans: [], events: [], industries: [], families: [] };

const SUPER = h.adminToken(['*']);
const get = (path, token = SUPER) => h.request('GET', `${P}/admin/dashboard${path}`, { token });
const widget = (key, qs = '', token = SUPER) => get(`/widgets/${key}?fresh=1${qs ? `&${qs}` : ''}`, token);

const randomPhone = () => `+919${crypto.randomInt(100000000, 999999999)}`;
const backdate = (table, id, column = 'created_at', at = IN_RANGE) =>
  sequelize.query(`UPDATE \`${table}\` SET \`${column}\` = :at WHERE id = :id`, { replacements: { at, id } });

async function makeUser(attrs = {}) {
  const u = await models.User.create({ uid: uuid(), name: `Dash ${uuid().slice(0, 8)}`, phone: randomPhone(), ...attrs });
  track.users.push(u.id);
  await backdate('users', u.id);
  return u;
}

async function session(userId, clientType) {
  return models.UserSession.create({
    uid: uuid(), actor_type: 'user', actor_id: userId, jti: uuid(), refresh_token_hash: 'x',
    client_type: clientType, expires_at: new Date(Date.now() + 86400000),
  });
}

let u1; let u2; let u3;

before(async () => {
  await sequelize.authenticate();
  await h.start();

  // Three signups in the window: u1 went all the way, u2 stopped after choosing an
  // account type, u3 did nothing. u1's FIRST session is android — the later web
  // one must not move it.
  u1 = await makeUser({ account_type: 'business', onboarding_completed_at: new Date() });
  u2 = await makeUser({ account_type: 'personal' });
  u3 = await makeUser();
  await session(u1.id, 'android');
  await session(u1.id, 'web');
  await session(u2.id, 'ios');

  const project = await models.Project.create({ uid: uuid(), user_id: u1.id, name: 'Dash project' });
  const e1 = await models.ProjectExport.create({ uid: uuid(), project_id: project.id, user_id: u1.id, export_type: 'download', status: 'success' });
  const e2 = await models.ProjectExport.create({ uid: uuid(), project_id: project.id, user_id: u1.id, export_type: 'share', platform: 'whatsapp', status: 'success' });
  await backdate('project_exports', e1.id);
  await backdate('project_exports', e2.id);

  // Payments: two successes (one a pre-discriminator NULL purchase_type, which
  // counts as a frame), one failure, one abandoned checkout.
  const pay = async (attrs) => {
    const p = await models.Payment.create({ uid: uuid(), user_id: u1.id, gst_rate: 18, ...attrs });
    await backdate('payments', p.id);
    if (attrs.status === 'success') await backdate('payments', p.id, 'paid_at');
    return p;
  };
  await pay({ purchase_type: 'subscription', amount: 1180, amount_before_tax: 1000, gst_amount: 180, status: 'success' });
  await pay({ purchase_type: null, order_type: 'one_time', amount: 118, amount_before_tax: 100, gst_amount: 18, status: 'success' });
  await pay({ purchase_type: 'subscription', amount: 1180, amount_before_tax: 1000, gst_amount: 180, status: 'failed', failure_reason: 'Card declined' });
  await pay({ purchase_type: 'frame', amount: 59, amount_before_tax: 50, gst_amount: 9, status: 'pending' });

  for (const rating of [1, 5]) {
    const f = await models.Feedback.create({ uid: uuid(), user_id: u2.id, rating, message: rating === 1 ? 'bad' : null, platform: 'android' });
    await backdate('feedbacks', f.id);
  }
});

after(async () => {
  if (track.users.length) {
    const ids = { replacements: { ids: track.users } };
    for (const table of ['payments', 'project_exports', 'projects', 'feedbacks', 'user_subscriptions']) {
      await sequelize.query(`DELETE FROM \`${table}\` WHERE user_id IN (:ids)`, ids);
    }
    await sequelize.query(`DELETE FROM user_sessions WHERE actor_type = 'user' AND actor_id IN (:ids)`, ids);
    await models.User.destroy({ where: { id: track.users } });
  }
  if (track.plans.length)      await models.Plan.destroy({ where: { id: track.plans } });
  if (track.events.length)     await models.SpecialEvent.destroy({ where: { id: track.events } });
  if (track.families.length)   await models.TemplateFamily.destroy({ where: { id: track.families } });
  if (track.industries.length) await models.BusinessCategory.destroy({ where: { id: track.industries } });
  await h.stop();
  await sequelize.close();
});

// ---- pure helpers ------------------------------------------------------------

test('bucketOf: weeks start Monday, months on the 1st', () => {
  assert.equal(dashboard.bucketOf('2001-03-01', 'day'), '2001-03-01');
  assert.equal(dashboard.bucketOf('2001-03-01', 'week'), '2001-02-26');   // a Thursday
  assert.equal(dashboard.bucketOf('2001-03-04', 'week'), '2001-02-26');   // Sunday stays in the same week
  assert.equal(dashboard.bucketOf('2001-03-05', 'week'), '2001-03-05');   // Monday starts the next
  assert.equal(dashboard.bucketOf('2001-03-17', 'month'), '2001-03-01');
});

test('resolveRange: IST day boundaries and an equal-length span', () => {
  const r = dashboard.resolveRange({ from: FROM, to: TO });
  assert.equal(r.days, 10);
  // IST midnight is 18:30 UTC the day before.
  assert.equal(r.start.toISOString(), '2001-02-28T18:30:00.000Z');
  assert.equal(r.end.toISOString(),   '2001-03-10T18:30:00.000Z');
  assert.equal(dashboard.resolveRange({}, 30).days, 30);
});

test('renewalOutcome: cancellation wins, then a live mandate, else it simply expires', () => {
  assert.equal(dashboard.renewalOutcome({ cancelled_at: new Date(), auto_renew: 1, razorpay_subscription_id: 'sub_x' }), 'cancelling');
  assert.equal(dashboard.renewalOutcome({ cancelled_at: null, auto_renew: 1, razorpay_subscription_id: 'sub_x' }), 'renews');
  assert.equal(dashboard.renewalOutcome({ cancelled_at: null, auto_renew: 1, razorpay_subscription_id: null }), 'expires');
  assert.equal(dashboard.renewalOutcome({ cancelled_at: null, auto_renew: 0, razorpay_subscription_id: 'sub_x' }), 'expires');
});

// ---- permissions ---------------------------------------------------------------

test('manifest: super admin sees every widget, grouped into sections', async () => {
  const res = await get('/widgets');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.widgets.length, dashboard.WIDGETS.length);
  assert.deepEqual(res.body.data.sections.map((s) => s.key), ['money', 'growth', 'content', 'todo', 'system']);
  const w = res.body.data.widgets.find((x) => x.key === 'revenue_trend');
  assert.equal(w.permission, 'dashboard.revenue_trend');
  assert.equal(w.endpoint, '/admin/dashboard/widgets/revenue_trend');
  assert.deepEqual(w.params, ['from', 'to', 'granularity']);
});

test('manifest: a role sees exactly the widgets it is granted, and only their sections', async () => {
  const token = h.adminToken(['templates.*', 'dashboard.catalog_coverage', 'dashboard.draft_templates']);
  const res = await get('/widgets', token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.widgets.map((w) => w.key), ['catalog_coverage', 'draft_templates']);
  assert.deepEqual(res.body.data.sections.map((s) => s.key), ['content', 'todo']);
});

test('manifest: no dashboard grants is an empty dashboard, not a 403', async () => {
  const res = await get('/widgets', h.adminToken(['templates.*']));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { sections: [], widgets: [] });
});

test('manifest: `dashboard.*` grants every widget', async () => {
  const res = await get('/widgets', h.adminToken(['dashboard.*']));
  assert.equal(res.body.data.widgets.length, dashboard.WIDGETS.length);
});

test('widget: refused without its own permission, even with another widget granted', async () => {
  const token = h.adminToken(['dashboard.catalog_coverage']);
  assert.equal((await widget('catalog_coverage', '', token)).status, 200);
  const res = await widget('revenue_summary', '', token);
  assert.equal(res.status, 403);
  assert.match(res.body.error?.message || JSON.stringify(res.body), /dashboard\.revenue_summary/);
});

test('widget: unknown key is 404; user tokens are refused', async () => {
  assert.equal((await widget('no_such_widget')).status, 404);
  const userToken = h.userTokenFor(u1.id);
  assert.equal((await get('/widgets', userToken)).status, 403);
  assert.equal((await widget('user_summary', '', userToken)).status, 403);
});

test('widget: invalid parameters are 400', async () => {
  for (const qs of ['from=2001-3-1', 'from=2001-03-10&to=2001-03-01', 'from=2001-02-30&to=2001-03-01',
    'from=2000-01-01&to=2001-12-31', 'granularity=hour']) {
    assert.equal((await widget('revenue_trend', qs)).status, 400, qs);
  }
  assert.equal((await widget('renewals_due', 'days=0')).status, 400);
  assert.equal((await widget('catalog_coverage', 'min=abc')).status, 400);
});

test('widget: results are cached briefly; fresh=1 bypasses', async () => {
  dashboard._clearCache();
  const a = await get('/widgets/user_summary');
  const b = await get('/widgets/user_summary');
  assert.equal(a.body.meta.cached, false);
  assert.equal(b.body.meta.cached, true);
  assert.equal((await widget('user_summary')).body.meta.cached, false);
});

// ---- Money -----------------------------------------------------------------

test('revenue_trend: success payments only, by IST day, NULL purchase_type counted as frame', async () => {
  const res = await widget('revenue_trend', `from=${FROM}&to=${TO}`);
  assert.equal(res.status, 200);
  const d = res.body.data;
  assert.deepEqual(d.totals, { gross: 1298, net: 1100, count: 2 });
  assert.equal(d.points.length, 10);                                  // gap-filled
  const day = d.points.find((p) => p.date === '2001-03-05');
  assert.deepEqual(day.by_type, { subscription: 1180, frame: 118, quota_pack: 0 });
  assert.equal(d.points.filter((p) => p.count).length, 1);

  const monthly = (await widget('revenue_trend', `from=${FROM}&to=${TO}&granularity=month`)).body.data;
  assert.deepEqual(monthly.points.map((p) => [p.date, p.gross]), [['2001-03-01', 1298]]);
  const weekly = (await widget('revenue_trend', `from=${FROM}&to=${TO}&granularity=week`)).body.data;
  assert.deepEqual(weekly.points.map((p) => p.date), ['2001-02-26', '2001-03-05']);
});

test('payment_health: outcome counts, success rate, abandoned checkouts, failures', async () => {
  const d = (await widget('payment_health', `from=${FROM}&to=${TO}`)).body.data;
  assert.deepEqual(d.counts, { success: 2, failed: 1, pending: 1, refunded: 0 });
  assert.equal(d.success_rate_pct, 66.7);
  assert.equal(d.stale_pending.count, 1);
  assert.deepEqual(d.top_failure_reasons, [{ reason: 'Card declined', count: 1 }]);
  assert.equal(d.recent_failures[0].user.uid, u1.uid);
});

test('subscribers_by_plan + renewals_due: an active sub ending soon, with its renewal outcome', async () => {
  const plan = await models.Plan.create({ uid: uuid(), name: `Dash plan ${uuid().slice(0, 8)}`, plan_type: 'subscription', status: 'inactive' });
  track.plans.push(plan.id);
  const endsAt = new Date(Date.now() + 3 * 86400000);
  const sub = await models.UserSubscription.create({
    uid: uuid(), user_id: u1.id, plan_id: plan.id, status: 'active', sub_type: 'regular',
    starts_at: new Date(Date.now() - 27 * 86400000), ends_at: endsAt, auto_renew: 1, amount_paid: 1180,
    razorpay_subscription_id: 'sub_dashboard_test',
  });
  // An expired-in-place row is not active, whatever its status says.
  await models.UserSubscription.create({
    uid: uuid(), user_id: u2.id, plan_id: plan.id, status: 'active', sub_type: 'regular',
    starts_at: new Date(Date.now() - 40 * 86400000), ends_at: new Date(Date.now() - 86400000), amount_paid: 0,
  });

  const plans = (await widget('subscribers_by_plan')).body.data.plans;
  const mine = plans.find((p) => p.uid === plan.uid);
  assert.equal(mine.total, 1);
  assert.equal(mine.by_sub_type.regular, 1);

  const due = (await widget('renewals_due', 'days=7&limit=200')).body.data;
  const row = due.subscriptions.find((s) => s.uid === sub.uid);
  assert.ok(row, 'sub ending in 3 days is listed');
  assert.equal(row.outcome, 'renews');
  assert.equal(row.user.uid, u1.uid);
  assert.ok(due.counts.renews >= 1);
  assert.equal((await widget('renewals_due', 'days=2&limit=200')).body.data.subscriptions.some((s) => s.uid === sub.uid), false);
});

// ---- Growth ----------------------------------------------------------------

test('signups_by_platform: the FIRST session decides; no session is unknown', async () => {
  const d = (await widget('signups_by_platform', `from=${FROM}&to=${TO}`)).body.data;
  assert.equal(d.total, 3);
  const by = Object.fromEntries(d.platforms.map((p) => [p.platform, p.count]));
  assert.deepEqual(by, { android: 1, ios: 1, web: 0, playground: 0, unknown: 1 });
});

test('signup_funnel: cohort counts and conversion at each step', async () => {
  const d = (await widget('signup_funnel', `from=${FROM}&to=${TO}`)).body.data;
  assert.deepEqual(d.stages.map((s) => [s.key, s.count]), [
    ['signed_up', 3], ['onboarding_started', 2], ['onboarding_completed', 1],
    ['created_project', 1], ['exported', 1], ['paid', 1],
  ]);
  assert.equal(d.stages[1].pct_of_signups, 66.7);
  assert.equal(d.stages[2].pct_of_previous, 50);
});

test('export_summary: by type and share platform', async () => {
  const d = (await widget('export_summary', `from=${FROM}&to=${TO}`)).body.data;
  assert.deepEqual(d.totals, { total: 2, success: 2, failed: 0, pending: 0, unique_users: 1 });
  assert.deepEqual(d.by_type, { download: 1, share: 1 });
  assert.equal(d.shares_by_platform.whatsapp, 1);
  assert.equal(d.success_rate_pct, 100);
});

test('user_summary: signup windows compare against the previous period', async () => {
  const d = (await widget('user_summary')).body.data;
  assert.deepEqual(d.signups.map((s) => s.key), ['today', 'last_7d', 'last_30d']);
  assert.equal(d.signups[1].previous.days, 7);
  assert.ok(d.users.total >= 3);
});

// ---- Content / To-do ---------------------------------------------------------

test('catalog_coverage: an industry with no live designs is listed', async () => {
  const ind = await models.BusinessCategory.create({ uid: uuid(), name: `Dash industry ${uuid().slice(0, 8)}`, status: 'approved', is_active: 1 });
  track.industries.push(ind.id);
  const d = (await widget('catalog_coverage', 'min=1&limit=500')).body.data;
  const row = d.industries.items.find((i) => i.uid === ind.uid);
  assert.ok(row);
  assert.equal(row.active_templates, 0);
});

test('events_without_templates: upcoming events short of live designs, with days_until', async () => {
  const inFive = ist.addDaysISO(ist.istDateISO(), 5);
  const bare = await models.SpecialEvent.create({ uid: uuid(), name: `Dash event ${uuid().slice(0, 8)}`, type: 'custom', full_date: inFive, is_recurring: 0 });
  const covered = await models.SpecialEvent.create({ uid: uuid(), name: `Dash covered ${uuid().slice(0, 8)}`, type: 'custom', full_date: inFive, is_recurring: 0 });
  track.events.push(bare.id, covered.id);
  const fam = await models.TemplateFamily.create({ uid: uuid(), name: `Dash fam ${uuid().slice(0, 8)}`, status: 'active' });
  track.families.push(fam.id);
  await models.SpecialEventTemplate.create({ event_id: covered.id, family_id: fam.id });

  const d = (await widget('events_without_templates', 'days=10')).body.data;
  const row = d.events.find((e) => e.uid === bare.uid);
  assert.ok(row);
  assert.equal(row.occurs_on, inFive);
  assert.equal(row.days_until, 5);
  assert.equal(d.events.some((e) => e.uid === covered.uid), false);
  // Raising the bar brings the covered one back.
  assert.ok((await widget('events_without_templates', 'days=10&min=2')).body.data.events.some((e) => e.uid === covered.uid));
});

test('pending_industries: a user suggestion awaiting review is queued with its suggester', async () => {
  const ind = await models.BusinessCategory.create({
    uid: uuid(), name: `Dash pending ${uuid().slice(0, 8)}`, status: 'pending', is_active: 0, suggested_by_user_id: u2.id,
  });
  track.industries.push(ind.id);
  const d = (await widget('pending_industries', 'limit=100')).body.data;
  assert.ok(d.count >= 1);
  const row = d.items.find((i) => i.uid === ind.uid);
  assert.ok(row);
  assert.equal(row.suggested_by.uid, u2.uid);
});

test('recent_feedback: aggregates only — no names or messages', async () => {
  const d = (await widget('recent_feedback', `from=${FROM}&to=${TO}`)).body.data;
  assert.equal(d.count, 2);
  assert.equal(d.average_rating, 3);
  assert.equal(d.low_ratings, 1);
  assert.equal(d.with_message, 1);
  assert.deepEqual(d.rating_distribution, { 1: 1, 2: 0, 3: 0, 4: 0, 5: 1 });
  assert.doesNotMatch(JSON.stringify(d), /bad|Dash /);
});

test('draft_templates: lists what each draft lacks, using the publish gate field keys', async () => {
  const fam = await models.TemplateFamily.create({ uid: uuid(), name: `Dash draft ${uuid().slice(0, 8)}`, status: 'draft' });
  track.families.push(fam.id);
  const d = (await widget('draft_templates', 'limit=100')).body.data;
  const row = d.items.find((i) => i.uid === fam.uid);
  assert.ok(row);
  assert.equal(row.ready, false);
  assert.deepEqual(row.missing, ['category_id', 'tag_ids', 'versions']);
  assert.ok(d.missing_counts.versions >= 1);
});

// ---- System ----------------------------------------------------------------

test('migration_status: compares migration files with SequelizeMeta', async () => {
  const d = (await widget('migration_status')).body.data;
  // test/prepare.js migrates the test DB, so nothing should be pending.
  assert.equal(d.up_to_date, true);
  assert.deepEqual(d.pending, []);
  assert.equal(d.applied_total, d.files_total);
  assert.match(d.last_applied, /^\d{14}-.+\.js$/);
});
