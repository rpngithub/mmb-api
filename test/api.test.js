const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { v4: uuid } = require('uuid');
const h = require('./helpers');

const { models } = h;
const { User, Business, Template, UserSubscription, Payment, ActivityLog, OtpCode } = models;
const { hashOtp } = require('../src/utils/otpHelper');

const P = '/api/v1';
let startLogId = 0;
const track = { users: [], templates: [], themes: [], themeGroups: [], faqCategories: [], faqs: [], testimonials: [], tags: [], templateSizes: [], businessCategories: [], templateCategories: [], assets: [], assetCategories: [], coupons: [] };

before(async () => {
  await models.sequelize.authenticate();
  await h.start();
  startLogId = (await ActivityLog.max('id')) || 0;
});

after(async () => {
  if (track.faqs.length)          await models.Faq.destroy({ where: { id: track.faqs } });
  if (track.faqCategories.length) await models.FaqCategory.destroy({ where: { id: track.faqCategories } });
  if (track.testimonials.length)  await models.Testimonial.destroy({ where: { id: track.testimonials } });
  if (track.themes.length)      await models.Theme.destroy({ where: { id: track.themes } });           // cascades joins
  if (track.themeGroups.length) await models.ThemeGroup.destroy({ where: { id: track.themeGroups } });
  if (track.templates.length) await Template.destroy({ where: { id: track.templates } }); // cascades template_tags / _sizes / _business_categories
  if (track.tags.length)              await models.Tag.destroy({ where: { id: track.tags } });
  if (track.templateSizes.length)     await models.TemplateSize.destroy({ where: { id: track.templateSizes } });
  if (track.businessCategories.length) await models.BusinessCategory.destroy({ where: { id: track.businessCategories } });
  if (track.templateCategories.length) await models.TemplateCategory.destroy({ where: { id: track.templateCategories } });
  if (track.assets.length)             await models.Asset.destroy({ where: { id: track.assets } });
  if (track.assetCategories.length)    await models.AssetCategory.destroy({ where: { id: track.assetCategories } });
  if (track.users.length)     await User.destroy({ where: { id: track.users } }); // cascades (incl. subscriptions)
  if (track.coupons.length)   await models.Coupon.destroy({ where: { id: track.coupons } }); // cascades plan restrictions
  await ActivityLog.destroy({ where: { id: { [require('sequelize').Op.gt]: startLogId } } });
  await h.stop();
  await models.sequelize.close();
});

// ---------- Public / config ----------
test('GET /config returns public settings', async () => {
  const r = await h.request('GET', `${P}/config`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.app_name, 'MakeMyBrand');
});

test('GET /business-categories is public and seeded', async () => {
  const r = await h.request('GET', `${P}/business-categories`);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 5);
});

test('GET /subscriptions/plans lists plans with billing options', async () => {
  const r = await h.request('GET', `${P}/subscriptions/plans`);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.find((p) => p.name === 'Pro'));
});

// ---------- Auth ----------
test('OTP login: send-otp then verify-otp issues tokens with free tier', async () => {
  const phone = `9${Date.now() % 1000000000}`;
  const send = await h.request('POST', `${P}/auth/send-otp`, { body: { phone, purpose: 'login' } });
  assert.equal(send.status, 200);
  assert.match(String(send.body.data.otp), /^\d{6}$/, 'otp exposed in test env');

  const verify = await h.request('POST', `${P}/auth/verify-otp`, {
    body: { phone, otp: send.body.data.otp, purpose: 'login', client_mnemonic: 'test' },
  });
  assert.equal(verify.status, 200);
  assert.ok(verify.body.data.access_token && verify.body.data.refresh_token);

  const claims = JSON.parse(Buffer.from(verify.body.data.access_token.split('.')[1], 'base64').toString());
  assert.equal(claims.actor_type, 'user');
  assert.equal(claims.tier, 'free');

  const u = await User.findOne({ where: { phone } });
  if (u) track.users.push(u.id);
});

test('verify-otp rejects a wrong OTP', async () => {
  const phone = `9${(Date.now() + 7) % 1000000000}`;
  await h.request('POST', `${P}/auth/send-otp`, { body: { phone, purpose: 'login' } });
  const verify = await h.request('POST', `${P}/auth/verify-otp`, {
    body: { phone, otp: '000000', purpose: 'login', client_mnemonic: 'test' },
  });
  assert.equal(verify.status, 401);
  const u = await User.findOne({ where: { phone } });
  if (u) track.users.push(u.id);
});

test('admin login succeeds with seeded credentials', async () => {
  const r = await h.request('POST', `${P}/auth/admin/login`, {
    body: { email: 'admin@makemybrand.com', password: 'Admin@123' },
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.access_token);
});

// Regression: /auth/refresh must mint an access token with the SAME claim set
// as login — crucially a non-empty `permissions` claim. A prior bug loaded the
// admin without its Role on refresh, dropping permissions and 403-ing the panel.
test('refresh issues an access token with identical claims to login', async () => {
  const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString());

  // permissions arrives either as an array or a JSON-encoded string depending on
  // the DB driver's JSON handling; both cases must be non-empty.
  const hasPerms = (c) => {
    if (Array.isArray(c.permissions)) return c.permissions.length > 0;
    if (typeof c.permissions === 'string') return JSON.parse(c.permissions).length > 0;
    return false;
  };

  const login = await h.request('POST', `${P}/auth/admin/login`, {
    body: { email: 'admin@makemybrand.com', password: 'Admin@123' },
  });
  assert.equal(login.status, 200);
  const loginClaims = decode(login.body.data.access_token);
  assert.ok(hasPerms(loginClaims), 'login token has a non-empty permissions claim');

  const refreshed = await h.request('POST', `${P}/auth/refresh`, {
    body: { refresh_token: login.body.data.refresh_token },
  });
  assert.equal(refreshed.status, 200);
  const refreshClaims = decode(refreshed.body.data.access_token);

  // Non-empty permissions carried through the refresh, matching login exactly.
  assert.ok(hasPerms(refreshClaims), 'refresh token has a non-empty permissions claim');
  assert.deepEqual(refreshClaims.permissions, loginClaims.permissions, 'refresh preserves permissions');
  assert.equal(refreshClaims.name,  loginClaims.name);
  assert.equal(refreshClaims.email, loginClaims.email);

  // Same claim set (ignoring per-token jti/iat/exp which are expected to differ).
  const stable = (c) => { const { jti, iat, exp, ...rest } = c; return rest; };
  assert.deepEqual(stable(refreshClaims), stable(loginClaims), 'login and refresh claim sets match');
});

// ---------- Premium gating ----------
test('premium template: locked for guest, unlocked for paid', async () => {
  const prem = await Template.create({ uid: uuid(), name: 'TST Premium', content: '{"x":1}', is_premium: 1, status: 'active' });
  track.templates.push(prem.id);

  const guest = await h.request('GET', `${P}/templates/${prem.uid}`);
  assert.equal(guest.status, 200);
  assert.equal(guest.body.data.is_locked, true);
  assert.equal(guest.body.data.content, undefined, 'content withheld from guest');

  const paid = await h.request('GET', `${P}/templates/${prem.uid}`, { token: h.userTokenFor(1, 'paid') });
  assert.equal(paid.body.data.is_locked, false);
  assert.equal(typeof paid.body.data.content, 'string', 'content served to paid');
});

// ---------- Theme premium (plan-scoped) gating ----------

// Create a user holding an ACTIVE subscription on the given plan; returns the user id.
async function userWithActivePlan(planId, salt) {
  const user = await User.create({ uid: uuid(), name: 'TST Sub User', phone: `9${(Date.now() + salt) % 1000000000}` });
  track.users.push(user.id);
  await UserSubscription.create({
    uid: uuid(), user_id: user.id, plan_id: planId, sub_type: 'regular', status: 'active',
    starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 299,
  });
  return user.id;
}

test('theme detail: card is public but templates are plan-gated by subscription', async () => {
  const group = await models.ThemeGroup.create({ uid: uuid(), name: 'TST Group', is_active: 1 });
  track.themeGroups.push(group.id);
  const theme = await models.Theme.create({
    uid: uuid(), group_id: group.id, name: 'TST Pro Theme', description: 'Premium theme', likes_count: 42, is_active: 1,
  });
  track.themes.push(theme.id);
  const tpl = await Template.create({ uid: uuid(), name: 'TST Theme Tpl', content: '{"a":1}', status: 'active' });
  track.templates.push(tpl.id);
  await theme.setTemplates([tpl.id]);
  await theme.setPlans([2]);                 // entitled: Pro (plan id 2)
  await theme.setBusinessCategories([1, 5]); // display tags

  // guest -> card visible, templates locked, entitlement set hidden
  const guest = await h.request('GET', `${P}/themes/${theme.uid}`);
  assert.equal(guest.status, 200);
  assert.equal(guest.body.data.is_locked, true);
  assert.equal(guest.body.data.Templates, undefined, 'templates withheld from guest');
  assert.equal(guest.body.data.description, 'Premium theme');
  assert.equal(guest.body.data.likes_count, 42);
  assert.equal(guest.body.data.BusinessCategories.length, 2, 'business tags on the card');
  assert.equal(guest.body.data.Plans, undefined, 'entitlement set never exposed');

  // user with an ACTIVE Pro subscription -> entitled, templates (with content) served
  const proUserId = await userWithActivePlan(2, 11);
  const entitled = await h.request('GET', `${P}/themes/${theme.uid}`, { token: h.userTokenFor(proUserId, 'paid') });
  assert.equal(entitled.body.data.is_locked, false);
  assert.ok(Array.isArray(entitled.body.data.Templates) && entitled.body.data.Templates.length === 1);
  assert.equal(typeof entitled.body.data.Templates[0].content, 'string', 'content served to entitled viewer');

  // user on a DIFFERENT plan (Free, id 1) -> locked (proves plan-scoping, not just "any paid")
  const freeUserId = await userWithActivePlan(1, 22);
  const wrongPlan = await h.request('GET', `${P}/themes/${theme.uid}`, { token: h.userTokenFor(freeUserId, 'paid') });
  assert.equal(wrongPlan.body.data.is_locked, true, 'plan not in the theme allowlist -> locked');
});

test('theme with no plan restrictions is locked to everyone (incl. subscribers)', async () => {
  const group = await models.ThemeGroup.create({ uid: uuid(), name: 'TST Group2', is_active: 1 });
  track.themeGroups.push(group.id);
  const theme = await models.Theme.create({ uid: uuid(), group_id: group.id, name: 'TST Unrestricted', is_active: 1 });
  track.themes.push(theme.id);
  const tpl = await Template.create({ uid: uuid(), name: 'TST T2', content: '{}', status: 'active' });
  track.templates.push(tpl.id);
  await theme.setTemplates([tpl.id]); // no setPlans -> no rows -> nobody

  const proUserId = await userWithActivePlan(2, 33);
  const r = await h.request('GET', `${P}/themes/${theme.uid}`, { token: h.userTokenFor(proUserId, 'paid') });
  assert.equal(r.body.data.is_locked, true);
  assert.equal(r.body.data.Templates, undefined);
});

test('public /templates no longer exposes theme templates (theme_id is not an anchor)', async () => {
  const r = await h.request('GET', `${P}/templates?theme_id=1`);
  assert.equal(r.status, 400, 'theme_id alone is not a valid anchor');
});

test('admin theme relations: set plan entitlements + business categories, read back', async () => {
  const token = h.adminToken(['themes.*']);
  const group = await models.ThemeGroup.create({ uid: uuid(), name: 'TST Group3', is_active: 1 });
  track.themeGroups.push(group.id);
  const theme = await models.Theme.create({ uid: uuid(), group_id: group.id, name: 'TST Rel', is_active: 1 });
  track.themes.push(theme.id);

  const set = await h.request('PUT', `${P}/admin/themes/${theme.uid}/relations`, {
    token, body: { plan_ids: [2], business_category_ids: [1, 5] },
  });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.Plans.length, 1);
  assert.equal(set.body.data.BusinessCategories.length, 2);

  const get = await h.request('GET', `${P}/admin/themes/${theme.uid}/relations`, { token });
  assert.equal(get.status, 200);
  assert.equal(get.body.data.Plans[0].id, 2);

  // empty body is rejected by the relations validator
  const bad = await h.request('PUT', `${P}/admin/themes/${theme.uid}/relations`, { token, body: {} });
  assert.equal(bad.status, 400);
});

// ---------- "Add to your Business" (theme adoption) ----------
test('add to your business: only an entitled owner can adopt; adoption is durable', async () => {
  const group = await models.ThemeGroup.create({ uid: uuid(), name: 'TST AdoptGrp', is_active: 1 });
  track.themeGroups.push(group.id);
  const theme = await models.Theme.create({ uid: uuid(), group_id: group.id, name: 'TST Adopt Theme', is_active: 1 });
  track.themes.push(theme.id);
  const tpl = await Template.create({ uid: uuid(), name: 'TST Adopt Tpl', content: '{"z":1}', status: 'active', category_id: 1 });
  track.templates.push(tpl.id);
  await theme.setTemplates([tpl.id]);
  await theme.setPlans([2]); // Pro-only

  const ownerId = (await User.create({ uid: uuid(), name: 'TST Owner', phone: `9${(Date.now() + 41) % 1000000000}` })).id;
  track.users.push(ownerId);
  const biz = await Business.create({ uid: uuid(), user_id: ownerId, name: 'TST Biz', is_active: 1 });
  const ownerTok = h.userTokenFor(ownerId, 'free');

  // no entitling plan -> cannot adopt
  const denied = await h.request('POST', `${P}/businesses/${biz.uid}/themes`, { token: ownerTok, body: { theme_uid: theme.uid } });
  assert.equal(denied.status, 403);

  // grant active Pro -> can adopt
  const sub = await UserSubscription.create({
    uid: uuid(), user_id: ownerId, plan_id: 2, sub_type: 'regular', status: 'active',
    starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 299,
  });
  const adopt = await h.request('POST', `${P}/businesses/${biz.uid}/themes`, { token: ownerTok, body: { theme_uid: theme.uid } });
  assert.equal(adopt.status, 201);
  assert.equal(adopt.body.data.Templates.length, 1);

  // listed in the collection, and idempotent (no duplicate on re-adopt)
  await h.request('POST', `${P}/businesses/${biz.uid}/themes`, { token: ownerTok, body: { theme_uid: theme.uid } });
  const listed = await h.request('GET', `${P}/businesses/${biz.uid}/themes`, { token: ownerTok });
  assert.equal(listed.body.data.length, 1);
  assert.equal(listed.body.data[0].uid, theme.uid);

  // DURABLE: the plan lapses, but the adopted theme stays unlocked...
  await sub.update({ status: 'expired' });
  const detail = await h.request('GET', `${P}/themes/${theme.uid}`, { token: ownerTok });
  assert.equal(detail.body.data.is_locked, false, 'adopted theme stays unlocked after lapse');
  // ...and its template can still be turned into a project
  const proj = await h.request('POST', `${P}/projects`, { token: ownerTok, body: { name: 'From adopted', template_id: tpl.id, content: '{"z":1}' } });
  assert.equal(proj.status, 201);

  // remove adoption -> re-locks (no sub, no adoption)
  const del = await h.request('DELETE', `${P}/businesses/${biz.uid}/themes/${theme.uid}`, { token: ownerTok });
  assert.equal(del.status, 200);
  const relocked = await h.request('GET', `${P}/themes/${theme.uid}`, { token: ownerTok });
  assert.equal(relocked.body.data.is_locked, true);
});

test('theme templates never surface in the public catalog (category browse + direct fetch + project)', async () => {
  const group = await models.ThemeGroup.create({ uid: uuid(), name: 'TST LeakGrp', is_active: 1 });
  track.themeGroups.push(group.id);
  const theme = await models.Theme.create({ uid: uuid(), group_id: group.id, name: 'TST Leak Theme', is_active: 1 });
  track.themes.push(theme.id);
  // a theme template that ALSO carries a public category and is not is_premium — must still be hidden
  const tpl = await Template.create({ uid: uuid(), name: 'TST Leak Tpl', content: '{"c":1}', status: 'active', category_id: 2, is_premium: 0 });
  track.templates.push(tpl.id);
  await theme.setTemplates([tpl.id]);
  await theme.setPlans([2]);

  const browse = await h.request('GET', `${P}/templates?category_id=2`);
  assert.equal(browse.status, 200);
  assert.ok(!browse.body.data.some((t) => t.uid === tpl.uid), 'theme template excluded from category browse');

  const direct = await h.request('GET', `${P}/templates/${tpl.uid}`);
  assert.equal(direct.status, 404, 'theme template hidden from the public template endpoint');

  const freeId = (await User.create({ uid: uuid(), name: 'TST Free', phone: `9${(Date.now() + 52) % 1000000000}` })).id;
  track.users.push(freeId);
  const proj = await h.request('POST', `${P}/projects`, { token: h.userTokenFor(freeId), body: { name: 'x', template_id: tpl.id, content: '{}' } });
  assert.equal(proj.status, 403, 'non-entitled/non-adopted user cannot project a theme template');
});

// ---------- Friendly slug / uid / id catalog params ----------
test('public /templates filters accept slug, uid, and legacy id (backward compatible)', async () => {
  // Seeded: template category 2 = "Business Promotion" (slug business-promotion);
  //         business category 1 = "Restaurant & Food" (slug restaurant-food).
  const stamp = Date.now();
  const tag = await models.Tag.create({ name: `TST Slug Tag ${stamp}`, slug: `tst-slug-tag-${stamp}` });
  track.tags.push(tag.id);

  const tpl = await Template.create({ uid: uuid(), name: `TST Slug Tpl ${stamp}`, content: '{"c":1}', status: 'active', category_id: 2, is_premium: 0 });
  track.templates.push(tpl.id);
  await tpl.setBusinessCategories([1]);
  await tpl.setTags([tag.id]);

  const has = (r) => r.body.data.some((t) => t.uid === tpl.uid);

  const bySlug = await h.request('GET', `${P}/templates?category=business-promotion`);
  const byId   = await h.request('GET', `${P}/templates?category_id=2`);
  assert.equal(bySlug.status, 200);
  assert.ok(has(bySlug), 'found via category slug');
  assert.ok(has(byId),   'found via legacy category_id (still works)');

  const cat2uid = (await models.TemplateCategory.findByPk(2)).uid;
  assert.ok(has(await h.request('GET', `${P}/templates?category=${cat2uid}`)), 'found via category uid');

  assert.ok(
    has(await h.request('GET', `${P}/templates?business_category=restaurant-food&tags=${tag.slug}`)),
    'found via business_category slug + tag slug',
  );

  // A supplied anchor that resolves to nothing => empty page, NOT the whole catalog and NOT 400.
  const bad = await h.request('GET', `${P}/templates?category=no-such-slug-xyz`);
  assert.equal(bad.status, 200);
  assert.equal(bad.body.data.length, 0, 'bad slug yields empty result');

  // No anchor at all => 400.
  assert.equal((await h.request('GET', `${P}/templates`)).status, 400);
});

test('business-categories expose slug and filter by parent slug/uid/id', async () => {
  const list = await h.request('GET', `${P}/business-categories`);
  assert.equal(list.status, 200);
  const restaurant = list.body.data.find((c) => c.slug === 'restaurant-food');
  assert.ok(restaurant, 'slug is present in the public response');

  const stamp = Date.now();
  const child = await models.BusinessCategory.create({ uid: uuid(), parent_id: restaurant.id, name: `TST Child ${stamp}`, slug: `tst-child-${stamp}`, is_active: 1 });
  track.businessCategories.push(child.id);

  const bySlug = await h.request('GET', `${P}/business-categories?parent=restaurant-food`);
  const byId   = await h.request('GET', `${P}/business-categories?parent_id=${restaurant.id}`);
  assert.ok(bySlug.body.data.some((c) => c.uid === child.uid), 'child found via parent slug');
  assert.ok(byId.body.data.some((c) => c.uid === child.uid),   'child found via legacy parent_id');
});

test('template-categories expose slug and filter by parent slug/uid/id (+ homepage)', async () => {
  const list = await h.request('GET', `${P}/template-categories`);
  assert.equal(list.status, 200);
  const parent = list.body.data.find((c) => c.slug === 'business-promotion');
  assert.ok(parent, 'slug present in template-categories response');

  const stamp = Date.now();
  const child = await models.TemplateCategory.create({ uid: uuid(), parent_id: parent.id, name: `TST TCat ${stamp}`, slug: `tst-tcat-${stamp}`, is_active: 1 });
  track.templateCategories.push(child.id);

  const bySlug = await h.request('GET', `${P}/template-categories?parent=business-promotion`);
  const byId   = await h.request('GET', `${P}/template-categories?parent_id=${parent.id}`);
  assert.ok(bySlug.body.data.some((c) => c.uid === child.uid), 'child found via parent slug');
  assert.ok(byId.body.data.some((c) => c.uid === child.uid),   'child found via legacy parent_id');

  // top-level filter excludes the child (it has a parent)
  const topLevel = await h.request('GET', `${P}/template-categories?parent=null`);
  assert.ok(!topLevel.body.data.some((c) => c.uid === child.uid), 'parent=null returns only top-level');
});

test('template-categories?tree nests parent→child and orders every level by display_order', async () => {
  const stamp = Date.now();
  // root → mid → two leaves (display_order 2 before 1 to prove sorting, not insert order)
  const root  = await models.TemplateCategory.create({ uid: uuid(), parent_id: null,    name: `TST Root ${stamp}`,  slug: `tst-root-${stamp}`,  display_order: 0, is_active: 1 });
  const mid   = await models.TemplateCategory.create({ uid: uuid(), parent_id: root.id,  name: `TST Mid ${stamp}`,   slug: `tst-mid-${stamp}`,   display_order: 0, is_active: 1 });
  const leafB = await models.TemplateCategory.create({ uid: uuid(), parent_id: mid.id,   name: `TST LeafB ${stamp}`, slug: `tst-leafb-${stamp}`, display_order: 2, is_active: 1 });
  const leafA = await models.TemplateCategory.create({ uid: uuid(), parent_id: mid.id,   name: `TST LeafA ${stamp}`, slug: `tst-leafa-${stamp}`, display_order: 1, is_active: 1 });
  track.templateCategories.push(leafA.id, leafB.id, mid.id, root.id); // children before parents for FK-safe teardown

  const res = await h.request('GET', `${P}/template-categories?tree=1`);
  assert.equal(res.status, 200);

  const rootNode = res.body.data.find((c) => c.uid === root.uid);
  assert.ok(rootNode, 'root present at top level');
  assert.equal(rootNode.children.length, 1, 'root has one child');

  const midNode = rootNode.children[0];
  assert.equal(midNode.uid, mid.uid, 'mid nested under root');
  assert.deepEqual(midNode.children.map((c) => c.uid), [leafA.uid, leafB.uid], 'leaves ordered by display_order ASC');

  // children never appear at the top level in tree mode
  assert.ok(!res.body.data.some((c) => c.uid === mid.uid || c.uid === leafA.uid), 'nested nodes not surfaced as roots');
});

test('admin template-categories reorder: rewrites display_order by array position (audited)', async () => {
  const token = h.adminToken(['categories.*']);
  const stamp = Date.now();
  // three siblings under the same parent, initial order a,b,c
  const a = await models.TemplateCategory.create({ uid: uuid(), parent_id: null, name: `TST RO A ${stamp}`, slug: `tst-ro-a-${stamp}`, display_order: 0, is_active: 1 });
  const b = await models.TemplateCategory.create({ uid: uuid(), parent_id: null, name: `TST RO B ${stamp}`, slug: `tst-ro-b-${stamp}`, display_order: 1, is_active: 1 });
  const c = await models.TemplateCategory.create({ uid: uuid(), parent_id: null, name: `TST RO C ${stamp}`, slug: `tst-ro-c-${stamp}`, display_order: 2, is_active: 1 });
  track.templateCategories.push(a.id, b.id, c.id);

  // reorder to c, a, b
  const res = await h.request('PATCH', `${P}/admin/template-categories/reorder`, { token, body: { ids: [c.uid, a.uid, b.uid] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data, null);

  for (const [row, order] of [[c, 0], [a, 1], [b, 2]]) {
    await row.reload();
    assert.equal(row.display_order, order, `${row.name} -> display_order ${order}`);
  }

  const logged = await ActivityLog.findOne({ where: { action: 'template_category.reordered' }, order: [['id', 'DESC']] });
  assert.ok(logged, 'reorder writes an activity log');
});

test('admin template-categories reorder: guards permission, unknown ids, and mixed parents', async () => {
  const token = h.adminToken(['categories.*']);
  const stamp = Date.now();
  const parent = await models.TemplateCategory.create({ uid: uuid(), parent_id: null, name: `TST ROG P ${stamp}`, slug: `tst-rog-p-${stamp}`, is_active: 1 });
  const child  = await models.TemplateCategory.create({ uid: uuid(), parent_id: parent.id, name: `TST ROG C ${stamp}`, slug: `tst-rog-c-${stamp}`, is_active: 1 });
  track.templateCategories.push(child.id, parent.id);

  // 403 without the categories permission
  const forbidden = await h.request('PATCH', `${P}/admin/template-categories/reorder`, { token: h.adminToken(['themes.*']), body: { ids: [parent.uid] } });
  assert.equal(forbidden.status, 403);

  // 400 empty ids (schema)
  const empty = await h.request('PATCH', `${P}/admin/template-categories/reorder`, { token, body: { ids: [] } });
  assert.equal(empty.status, 400);

  // 404 when an id doesn't exist
  const missing = await h.request('PATCH', `${P}/admin/template-categories/reorder`, { token, body: { ids: [parent.uid, uuid()] } });
  assert.equal(missing.status, 404);

  // 400 when ids span two different parents (reorder is sibling-scoped)
  const mixed = await h.request('PATCH', `${P}/admin/template-categories/reorder`, { token, body: { ids: [parent.uid, child.uid] } });
  assert.equal(mixed.status, 400);
});

// ---------- Admin CSV bulk import ----------
// Build a multipart/form-data body by hand (no new deps). `fields` maps a field
// name to a string value, or to { content, filename?, contentType? } for a file.
function multipart(fields) {
  const boundary = `----mmbtest${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const [name, v] of Object.entries(fields)) {
    if (v && typeof v === 'object' && 'content' in v) {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${v.filename || 'file.csv'}"\r\n`
        + `Content-Type: ${v.contentType || 'text/csv'}\r\n\r\n`));
      chunks.push(Buffer.from(String(v.content), 'utf8'));
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${v}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}
const importCsv = (entity, csv, { token, dryRun } = {}) => {
  const fields = { file: { content: csv, filename: `${entity}.csv` } };
  if (dryRun) fields.dry_run = '1';
  const mp = multipart(fields);
  return h.request('POST', `${P}/admin/imports/${entity}`, { token, body: mp.body, headers: mp.headers });
};

test('import: template download returns import + reference variants', async () => {
  const token = h.adminToken(['categories.*']);
  const imp = await h.request('GET', `${P}/admin/imports/industries/template`, { token });
  assert.equal(imp.status, 200);
  assert.ok(String(imp.body).includes('name,parent,slug'), 'import template has the header row');
  assert.ok(!/REFERENCE-ONLY/.test(String(imp.body)), 'import template is not the reference file');

  const ref = await h.request('GET', `${P}/admin/imports/industries/template?example=1`, { token });
  assert.equal(ref.status, 200);
  assert.ok(/REFERENCE-ONLY/.test(String(ref.body)), 'reference file carries the sentinel');

  // permission gate on the template download
  const forbidden = await h.request('GET', `${P}/admin/imports/industries/template`, { token: h.adminToken(['themes.*']) });
  assert.equal(forbidden.status, 403);
});

test('import industries: dry-run validates without writing', async () => {
  const stamp = Date.now();
  const name = `IMP Dry ${stamp}`;
  const csv = [
    'name,parent,slug,display_order,is_active,tags',
    `${name},,,1,1,`,
    ',,,1,1,', // missing name -> skipped
  ].join('\n');
  const res = await importCsv('industries', csv, { token: h.adminToken(['categories.*']), dryRun: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.dry_run, true);
  assert.equal(res.body.data.summary.created, 1);
  assert.equal(res.body.data.summary.skipped, 1);
  assert.equal(await models.BusinessCategory.findOne({ where: { name } }), null, 'dry run persists nothing');
});

test('import industries: upserts, resolves in-file parent, links tags, idempotent', async () => {
  const token = h.adminToken(['categories.*']);
  const stamp = Date.now();
  const parentName = `IMP Parent ${stamp}`;
  const childName  = `IMP Child ${stamp}`;
  const tagA = `imptag-a-${stamp}`;
  const tagB = `imptag-b-${stamp}`;
  // child listed BEFORE its parent — exercises the multi-pass parent resolution
  const csv = [
    'name,parent,slug,display_order,is_active,tags',
    `${childName},${parentName},,2,1,${tagB}`,
    `${parentName},,,1,1,${tagA}|${tagB}`,
  ].join('\n');

  const res = await importCsv('industries', csv, { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.summary.created, 2);
  assert.equal(res.body.data.summary.skipped, 0);

  const parent = await models.BusinessCategory.findOne({ where: { name: parentName }, include: [models.Tag] });
  const child  = await models.BusinessCategory.findOne({ where: { name: childName },  include: [models.Tag] });
  assert.ok(parent && child, 'both rows created');
  assert.equal(child.parent_id, parent.id, 'child linked to a parent defined later in the file');
  assert.equal(parent.Tags.length, 2, 'parent linked to both tags');
  assert.deepEqual(child.Tags.map((t) => t.name), [tagB], 'child linked to its single tag');
  track.businessCategories.push(child.id, parent.id);
  const tags = await models.Tag.findAll({ where: { name: [tagA, tagB] } });
  track.tags.push(...tags.map((t) => t.id));

  // re-import the same file -> everything updates, nothing new
  const again = await importCsv('industries', csv, { token });
  assert.equal(again.body.data.summary.updated, 2);
  assert.equal(again.body.data.summary.created, 0);
});

test('import industries: skips bad rows and cascades to children of a skipped parent', async () => {
  const stamp = Date.now();
  const badParent = `IMP BadParent ${stamp}`;
  const csv = [
    'name,parent,slug,display_order,is_active,tags',
    `${badParent},,,1,maybe,`,                // invalid is_active -> skipped
    `IMP Orphan ${stamp},${badParent},,2,1,`, // parent skipped -> cascade skip
    ',,,1,1,',                                // missing name -> skipped
  ].join('\n');
  const res = await importCsv('industries', csv, { token: h.adminToken(['categories.*']) });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.summary.created, 0);
  assert.equal(res.body.data.summary.skipped, 3);

  const rows = res.body.data.rows;
  assert.match(rows.find((r) => r.name === badParent).message, /is_active/);
  assert.match(rows.find((r) => r.name === `IMP Orphan ${stamp}`).message, /was not imported/);
  assert.ok(rows.some((r) => r.name === null && /name is required/.test(r.message)));
  assert.equal(await models.BusinessCategory.findOne({ where: { name: badParent } }), null, 'nothing persisted');
});

test('import: rejects the reference/example file, and enforces permission', async () => {
  const token = h.adminToken(['categories.*']);
  const ref = await h.request('GET', `${P}/admin/imports/industries/template?example=1`, { token });
  const rejected = await importCsv('industries', ref.body, { token });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error.message, /reference template/i);

  // missing categories.create -> 403
  const forbidden = await importCsv('industries', 'name\nX', { token: h.adminToken(['themes.*']) });
  assert.equal(forbidden.status, 403);
});

test('import themes: upserts themes and auto-creates the theme group', async () => {
  const stamp = Date.now();
  const groupName = `IMP Group ${stamp}`;
  const csv = [
    'group,name,description,display_order,is_active',
    `${groupName},IMP Theme A ${stamp},desc a,1,1`,
    `${groupName},IMP Theme B ${stamp},,2,1`,
  ].join('\n');
  const res = await importCsv('themes', csv, { token: h.adminToken(['themes.*']) });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.summary.created, 2);

  const group = await models.ThemeGroup.findOne({ where: { name: groupName } });
  assert.ok(group, 'theme group auto-created on the fly');
  const themes = await models.Theme.findAll({ where: { group_id: group.id } });
  assert.equal(themes.length, 2, 'both themes linked to the new group');
  track.themes.push(...themes.map((t) => t.id));
  track.themeGroups.push(group.id);
});

test('admin create auto-generates slug from name', async () => {
  const slugify = require('../src/utils/slugify');
  const name = `TST AutoSlug ${Date.now()}`;
  const created = await h.request('POST', `${P}/admin/business-categories`, { token: h.adminToken(), body: { name } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.slug, slugify(name), 'slug derived from name on create');
  track.businessCategories.push(created.body.data.id);
});

test('industry is the public alias for business_category (templates filter, /industries, create business)', async () => {
  // /industries mirrors /business-categories (same data, incl. slug)
  const industries = await h.request('GET', `${P}/industries`);
  assert.equal(industries.status, 200);
  assert.ok(industries.body.data.some((c) => c.slug === 'restaurant-food'), '/industries returns rows with slug');

  // templates filter: industry=<slug> anchors the browse
  const tpl = await Template.create({ uid: uuid(), name: `TST Ind Tpl ${Date.now()}`, content: '{"c":1}', status: 'active', category_id: 2, is_premium: 0 });
  track.templates.push(tpl.id);
  await tpl.setBusinessCategories([1]); // Restaurant & Food (id 1)
  const byIndustry = await h.request('GET', `${P}/templates?industry=restaurant-food`);
  assert.ok(byIndustry.body.data.some((t) => t.uid === tpl.uid), 'templates?industry=<slug> finds it');

  // create business with industry (slug) -> resolved to category_id
  const uId = (await User.create({ uid: uuid(), name: 'TST Ind User', phone: `9${(Date.now() + 71) % 1000000000}` })).id;
  track.users.push(uId);
  const created = await h.request('POST', `${P}/businesses`, { token: h.userTokenFor(uId), body: { name: 'TST Ind Biz', industry: 'restaurant-food' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.category_id, 1, 'industry slug resolved to category_id on create');

  // unknown industry -> clean 400
  const bad = await h.request('POST', `${P}/businesses`, { token: h.userTokenFor(uId), body: { name: 'TST Ind Bad', industry: 'no-such-industry' } });
  assert.equal(bad.status, 400);
});

test('public /assets filters by category slug/uid/id and tag slug (anchor required)', async () => {
  const stamp = Date.now();
  const cat = await models.AssetCategory.create({ uid: uuid(), name: `TST Asset Cat ${stamp}`, slug: `tst-asset-cat-${stamp}`, is_active: 1 });
  track.assetCategories.push(cat.id);
  const asset = await models.Asset.create({ uid: uuid(), category_id: cat.id, name: `TST Asset ${stamp}`, s3_key: 'k/x.png', asset_type: 'icon', status: 'active', is_premium: 0 });
  track.assets.push(asset.id);

  const has = (r) => r.body.data.some((a) => a.uid === asset.uid);

  const bySlug = await h.request('GET', `${P}/assets?category=${cat.slug}`);
  assert.equal(bySlug.status, 200);
  assert.ok(has(bySlug), 'asset found via category slug');
  assert.equal(bySlug.body.data[0].AssetCategory.slug, cat.slug, 'nested category carries slug');

  assert.ok(has(await h.request('GET', `${P}/assets?category=${cat.uid}`)),        'found via category uid');
  assert.ok(has(await h.request('GET', `${P}/assets?category_id=${cat.id}`)),       'found via legacy category_id');

  // supplied-but-unresolved anchor => empty page, not 400
  const bad = await h.request('GET', `${P}/assets?category=no-such-asset-cat`);
  assert.equal(bad.status, 200);
  assert.equal(bad.body.data.length, 0, 'bad category slug yields empty');

  // no anchor => 400
  assert.equal((await h.request('GET', `${P}/assets`)).status, 400);
});

// ---------- Ownership ----------
test('product ownership is enforced across users', async () => {
  const a = await User.create({ uid: uuid(), name: 'TST A', phone: `7${Date.now() % 1000000000}` });
  const b = await User.create({ uid: uuid(), name: 'TST B', phone: `6${(Date.now() + 3) % 1000000000}` });
  track.users.push(a.id, b.id);
  const biz = await Business.create({ uid: uuid(), user_id: a.id, name: 'TST Biz' });

  const created = await h.request('POST', `${P}/products`, {
    token: h.userTokenFor(a.id), body: { business_uid: biz.uid, name: 'Widget', price: 10 },
  });
  assert.equal(created.status, 201);

  const asB = await h.request('GET', `${P}/products/${created.body.data.uid}`, { token: h.userTokenFor(b.id) });
  assert.equal(asB.status, 403, 'B cannot read A product');
});

// ---------- Subscriptions: webhook ----------
function signWebhook(obj) {
  const raw = Buffer.from(JSON.stringify(obj));
  const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
  return { raw, sig };
}

test('webhook rejects an invalid signature', async () => {
  const r = await h.request('POST', `${P}/subscriptions/webhook`, {
    body: { event: 'payment.captured' }, headers: { 'x-razorpay-signature': 'bad' },
  });
  assert.equal(r.status, 401);
});

test('one-time webhook activates the subscription (and is idempotent)', async () => {
  const u = await User.create({ uid: uuid(), name: 'TST Pay', phone: `5${Date.now() % 1000000000}` });
  track.users.push(u.id);
  const sub = await UserSubscription.create({
    uid: uuid(), user_id: u.id, plan_id: 2, plan_billing_option_id: 1,
    status: 'pending', starts_at: new Date(), ends_at: new Date(), auto_renew: 0, amount_paid: 352.82,
  });
  const orderId = `order_${u.id}`;
  await Payment.create({
    uid: uuid(), user_id: u.id, subscription_id: sub.id, order_type: 'one_time',
    amount: 352.82, amount_before_tax: 299, gst_amount: 53.82, razorpay_order_id: orderId, status: 'pending',
  });

  const evt = { event: 'payment.captured', payload: { payment: { entity: { id: `pay_${u.id}`, order_id: orderId, amount: 35282 } } } };
  const { raw, sig } = signWebhook(evt);
  const r1 = await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.ok, true);
  assert.equal((await UserSubscription.findByPk(sub.id)).status, 'active');

  const r2 = await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });
  assert.equal(r2.body.idempotent, true, 'replay is idempotent');
});

// ---------- Coupons: redemption rules ----------
let couponSeq = 0;
const mkCoupon = async (over = {}) => {
  const c = await models.Coupon.create({
    uid: uuid(), code: `TSTCPN${Date.now()}${couponSeq++}`, title: 'Test coupon',
    discount_type: 'percentage', discount_value: 10,
    valid_from: new Date(Date.now() - 86400000), status: 'active', ...over,
  });
  track.coupons.push(c.id);
  return c;
};

const mkUser = async (prefix) => {
  const u = await User.create({ uid: uuid(), name: `TST ${prefix}`, phone: `6${Date.now() % 1000000000}${couponSeq++}`.slice(0, 10) });
  track.users.push(u.id);
  return u;
};

test('coupon verify enforces usage cap, plan restriction and target audience', async () => {
  const u     = await mkUser('Coupon');
  const token = h.userTokenFor(u.id);
  const V = (code, plan_id = 2) => h.request('POST', `${P}/subscriptions/coupon/verify`, { token, body: { code, plan_id } });

  assert.equal((await V('NO-SUCH-COUPON')).status, 404);

  const open = await mkCoupon();
  const rOk  = await V(open.code);
  assert.equal(rOk.status, 200);
  assert.equal(rOk.body.data.code, open.code);
  assert.equal(rOk.body.data.used_count, undefined, 'internal counters stay server-side');
  assert.equal(rOk.body.data.target_audience, undefined);

  const spent = await mkCoupon({ max_uses: 5, used_count: 5 });
  assert.equal((await V(spent.code)).status, 409, 'usage limit reached');

  // applicable_to='specific_plans' is honoured against the requested plan
  const scoped = await mkCoupon({ applicable_to: 'specific_plans' });
  await models.CouponPlanRestriction.create({ coupon_id: scoped.id, plan_id: 2 });
  assert.equal((await V(scoped.code, 2)).status, 200);
  assert.equal((await V(scoped.code, 1)).status, 409, 'not valid for an unlisted plan');

  // audience: this user has never subscribed
  const forNew = await mkCoupon({ target_audience: 'new_users' });
  const forOld = await mkCoupon({ target_audience: 'existing_users' });
  assert.equal((await V(forNew.code)).status, 200);
  assert.equal((await V(forOld.code)).status, 409);

  // an abandoned checkout (pending) must not burn new-user eligibility
  const pending = await UserSubscription.create({
    uid: uuid(), user_id: u.id, plan_id: 2, plan_billing_option_id: 1,
    status: 'pending', starts_at: new Date(), ends_at: new Date(), auto_renew: 0, amount_paid: 1,
  });
  assert.equal((await V(forNew.code)).status, 200, 'pending does not count as having subscribed');

  // ...but a real (non-pending) subscription flips both rules
  await pending.update({ status: 'expired' });
  assert.equal((await V(forNew.code)).status, 409);
  assert.equal((await V(forOld.code)).status, 200);
  await pending.destroy();
});

test('subscribe: an unusable coupon fails the request instead of silently charging full price', async () => {
  const u     = await mkUser('CouponSub');
  const token = h.userTokenFor(u.id);
  const spent = await mkCoupon({ max_uses: 1, used_count: 1 });
  const S = (coupon_code) => h.request('POST', `${P}/subscriptions`, { token, body: { plan_billing_option_id: 1, coupon_code } });

  assert.equal((await S('NO-SUCH-COUPON')).status, 404);
  assert.equal((await S(spent.code)).status, 409);
  assert.equal(await UserSubscription.count({ where: { user_id: u.id } }), 0, 'rejected before any pending row is created');
});

test('coupon usage is consumed on activation, exactly once, and the cap is a hard stop', async () => {
  const couponRepo = require('../src/repositories/coupon.repository');
  const u = await mkUser('CouponUse');
  const c = await mkCoupon({ max_uses: 1 });

  const sub = await UserSubscription.create({
    uid: uuid(), user_id: u.id, plan_id: 2, plan_billing_option_id: 1, coupon_id: c.id,
    status: 'pending', starts_at: new Date(), ends_at: new Date(), auto_renew: 0, amount_paid: 352.82,
  });
  const orderId = `order_cpn_${u.id}`;
  await Payment.create({
    uid: uuid(), user_id: u.id, subscription_id: sub.id, order_type: 'one_time',
    amount: 352.82, amount_before_tax: 299, gst_amount: 53.82, razorpay_order_id: orderId, status: 'pending',
  });

  const evt = { event: 'payment.captured', payload: { payment: { entity: { id: `pay_cpn_${u.id}`, order_id: orderId, amount: 35282 } } } };
  const { raw, sig } = signWebhook(evt);

  await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });
  assert.equal((await UserSubscription.findByPk(sub.id)).status, 'active');
  assert.equal((await models.Coupon.findByPk(c.id)).used_count, 1, 'consumed on activation');

  await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });
  assert.equal((await models.Coupon.findByPk(c.id)).used_count, 1, 'a redelivered webhook does not double-count');

  // the guarded UPDATE is the real cap: it refuses to push past max_uses
  assert.equal(await couponRepo.incrementUsage(c.id), false);
  assert.equal((await models.Coupon.findByPk(c.id)).used_count, 1);

  // an uncapped coupon always increments
  const uncapped = await mkCoupon();
  assert.equal(await couponRepo.incrementUsage(uncapped.id), true);
  assert.equal((await models.Coupon.findByPk(uncapped.id)).used_count, 1);
});

test('admin coupons: validates shape, cross-field rules and case-insensitive code uniqueness', async () => {
  const token = h.adminToken();
  const A     = `${P}/admin/coupons`;
  const base  = {
    code: `TSTADM${Date.now()}`, title: 'Admin coupon', discount_type: 'percentage',
    discount_value: 15, valid_from: '2026-01-01T00:00:00Z', valid_to: '2026-12-31T00:00:00Z',
  };
  const post  = (body) => h.request('POST', A, { token, body });

  // shape: unknown enum, bad code charset, non-positive value, missing required
  assert.equal((await post({ ...base, status: 'archived' })).status, 400);
  assert.equal((await post({ ...base, code: 'SAVE 20%' })).status, 400, 'code charset');
  assert.equal((await post({ ...base, discount_value: 0 })).status, 400, 'value must be positive');
  assert.equal((await post({ code: 'TSTNOTITLE1' })).status, 400, 'title/type/value/valid_from required');

  // used_count is system-managed, not admin-settable
  const r = await post({ ...base, used_count: 99 });
  assert.equal(r.status, 400);
  assert.ok(r.body.error.details.some((d) => d.field === 'used_count'));

  // cross-field: percentage > 100, and valid_to before valid_from
  const over = await post({ ...base, discount_value: 150 });
  assert.equal(over.status, 400);
  assert.ok(over.body.error.details.some((d) => d.field === 'discount_value'));
  const flipped = await post({ ...base, valid_from: '2026-12-31T00:00:00Z', valid_to: '2026-01-01T00:00:00Z' });
  assert.equal(flipped.status, 400);
  assert.ok(flipped.body.error.details.some((d) => d.field === 'valid_to'));

  // a fixed coupon may exceed 100 (₹150 off is legitimate)
  const fixed = await post({ ...base, code: `${base.code}F`, discount_type: 'fixed', discount_value: 150 });
  assert.equal(fixed.status, 201);
  track.coupons.push(fixed.body.data.id);

  const ok = await post(base);
  assert.equal(ok.status, 201);
  track.coupons.push(ok.body.data.id);

  // uniqueness is case-insensitive (MySQL _ci collation via adminCrud `unique`)
  assert.equal((await post({ ...base, code: base.code.toLowerCase() })).status, 409);

  // PATCH is judged on the MERGED state: switching to percentage alone must trip
  // the >100 rule against the stored 150, and lowering max_uses below used_count fails
  const patch = (id, body) => h.request('PATCH', `${A}/${id}`, { token, body });
  assert.equal((await patch(fixed.body.data.uid, { discount_type: 'percentage' })).status, 400, 'merged state is checked');
  assert.equal((await patch(fixed.body.data.uid, { discount_type: 'percentage', discount_value: 20 })).status, 200);

  await models.Coupon.update({ used_count: 3 }, { where: { id: ok.body.data.id } });
  assert.equal((await patch(ok.body.data.uid, { max_uses: 2 })).status, 400, 'cap below redemptions already used');
  assert.equal((await patch(ok.body.data.uid, { max_uses: 5 })).status, 200);

  // permission is still enforced
  assert.equal((await h.request('POST', A, { token: h.adminToken(['faqs.*']), body: base })).status, 403);
});

test('admin coupon plans: scoping is a full replace that keeps applicable_to in step', async () => {
  const token = h.adminToken();
  const A     = `${P}/admin/coupons`;
  // Resolve plan ids by name — the seeder's explicit ids don't survive admins
  // creating/deleting plans, so a hardcoded 2/3 is not stable across databases.
  const planId = async (name) => (await models.Plan.findOne({ where: { name } })).id;
  const [proId, passId, freeId] = await Promise.all([planId('Pro'), planId('All-Access Pass'), planId('Free')]);

  const create = await h.request('POST', A, {
    token,
    body: {
      code: `TSTSCOPE${Date.now()}`, title: 'Scoped coupon', discount_type: 'percentage',
      discount_value: 10, valid_from: '2026-01-01T00:00:00Z',
    },
  });
  assert.equal(create.status, 201);
  const { uid, id } = create.body.data;
  track.coupons.push(id);

  // a brand-new coupon is all_plans with no scoping
  const empty = await h.request('GET', `${A}/${uid}/plans`, { token });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.data.applicable_to, 'all_plans');
  assert.equal(empty.body.data.plans.length, 0);

  // applicable_to cannot be hand-set to specific_plans while no plans are linked
  const hand = await h.request('PATCH', `${A}/${uid}`, { token, body: { applicable_to: 'specific_plans' } });
  assert.equal(hand.status, 400);
  assert.ok(hand.body.error.details.some((d) => d.field === 'applicable_to'));

  // unknown plan ids are rejected wholesale
  assert.equal((await h.request('PUT', `${A}/${uid}/plans`, { token, body: { plan_ids: [proId, 999999] } })).status, 404);
  assert.equal((await h.request('GET', `${A}/${uid}/plans`, { token })).body.data.plans.length, 0, 'nothing partially written');

  // an access-pass plan is bought without a coupon code, so scoping to one is refused
  const pass = await h.request('PUT', `${A}/${uid}/plans`, { token, body: { plan_ids: [proId, passId] } });
  assert.equal(pass.status, 400);
  assert.ok(pass.body.error.details.some((d) => d.field === 'plan_ids'));
  assert.equal((await h.request('GET', `${A}/${uid}/plans`, { token })).body.data.plans.length, 0, 'nothing partially written');

  // linking plans flips applicable_to for you
  const linked = await h.request('PUT', `${A}/${uid}/plans`, { token, body: { plan_ids: [proId, freeId] } });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.data.applicable_to, 'specific_plans');
  assert.deepEqual(linked.body.data.plans.map((p) => p.id).sort(), [proId, freeId].sort());

  // full replace, not append
  const replaced = await h.request('PUT', `${A}/${uid}/plans`, { token, body: { plan_ids: [proId] } });
  assert.deepEqual(replaced.body.data.plans.map((p) => p.id), [proId]);

  // the scoping is now actually enforced at redemption
  const u     = await mkUser('Scoped');
  const utok  = h.userTokenFor(u.id);
  const code  = create.body.data.code;
  const V = (plan_id) => h.request('POST', `${P}/subscriptions/coupon/verify`, { token: utok, body: { code, plan_id } });
  assert.equal((await V(proId)).status, 200, 'valid for the linked plan');
  assert.equal((await V(freeId)).status, 409, 'rejected for an unlinked plan');

  // clearing returns it to all_plans, and it works everywhere again
  const cleared = await h.request('PUT', `${A}/${uid}/plans`, { token, body: { plan_ids: [] } });
  assert.equal(cleared.body.data.applicable_to, 'all_plans');
  assert.equal(cleared.body.data.plans.length, 0);
  assert.equal((await V(freeId)).status, 200, 'all_plans again');

  // permission is enforced on both verbs
  assert.equal((await h.request('GET', `${A}/${uid}/plans`, { token: h.adminToken(['faqs.*']) })).status, 403);
  assert.equal((await h.request('PUT', `${A}/${uid}/plans`, { token: h.adminToken(['coupons.read']), body: { plan_ids: [] } })).status, 403);
});

// ---------- Admin RBAC + audit ----------
test('admin templates: 401 no token, 403 for user, 201 for super admin (audited)', async () => {
  assert.equal((await h.request('GET', `${P}/admin/templates`)).status, 401);
  assert.equal((await h.request('GET', `${P}/admin/templates`, { token: h.userTokenFor(1) })).status, 403);

  // No `status` here: templates are born as drafts and publishing is gated separately.
  const created = await h.request('POST', `${P}/admin/templates`, {
    token: h.adminToken(['*']), body: { name: 'TST Admin Tpl' },
  });
  assert.equal(created.status, 201);
  track.templates.push(created.body.data.id);

  const logged = await ActivityLog.findOne({ where: { action: 'template.created', entity_id: created.body.data.id } });
  assert.ok(logged, 'mutation written to activity_logs');
});

test('limited admin is allowed in-domain but 403 out-of-domain', async () => {
  const token = h.adminToken(['templates.*']);
  const okTpl = await h.request('POST', `${P}/admin/templates`, { token, body: { name: 'TST Limited Tpl' } });
  assert.equal(okTpl.status, 201);
  track.templates.push(okTpl.body.data.id);

  const denied = await h.request('POST', `${P}/admin/plans`, { token, body: { name: 'TST Plan' } });
  assert.equal(denied.status, 403);
});

// ---------- FAQ categories: validation + case-insensitive uniqueness ----------
test('admin faq-categories: validates name and rejects case-insensitive duplicates', async () => {
  const token = h.adminToken(['*']);

  // Missing required name -> clean 400 (Joi), not a raw DB error.
  const bad = await h.request('POST', `${P}/admin/faq-categories`, { token, body: { display_order: 1 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

  const name = `TST Cat ${Date.now()}`;
  const created = await h.request('POST', `${P}/admin/faq-categories`, { token, body: { name } });
  assert.equal(created.status, 201);
  track.faqCategories.push(created.body.data.id);

  // Same name in different case -> 409 (collation makes the check case-insensitive).
  const dupe = await h.request('POST', `${P}/admin/faq-categories`, { token, body: { name: name.toUpperCase() } });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.error.code, 'CONFLICT');
});

// ---------- FAQs: validation + nested category in responses ----------
test('admin faqs: validates required fields and nests its category', async () => {
  const token = h.adminToken(['*']);

  const cat = await h.request('POST', `${P}/admin/faq-categories`, { token, body: { name: `TST FaqCat ${Date.now()}` } });
  track.faqCategories.push(cat.body.data.id);

  // Missing answer -> 400.
  const bad = await h.request('POST', `${P}/admin/faqs`, { token, body: { question: 'Q only?' } });
  assert.equal(bad.status, 400);

  const created = await h.request('POST', `${P}/admin/faqs`, {
    token, body: { question: 'TST Q?', answer: 'TST A.', category_id: cat.body.data.id },
  });
  assert.equal(created.status, 201);
  track.faqs.push(created.body.data.id);

  // List returns the joined FaqCategory (include), and filters by category_id.
  const list = await h.request('GET', `${P}/admin/faqs?category_id=${cat.body.data.id}`, { token });
  assert.equal(list.status, 200);
  const row = list.body.data.find((f) => f.id === created.body.data.id);
  assert.ok(row && row.FaqCategory && row.FaqCategory.id === cat.body.data.id, 'category nested in list');
});

// ---------- Testimonials: validation (the "name is mandatory" bug) ----------
test('admin testimonials: missing name -> clean 400, rating bounded 1..5', async () => {
  const token = h.adminToken(['*']);

  // The bug report: a missing name surfaced as a raw Sequelize error. Now a clean 400.
  const noName = await h.request('POST', `${P}/admin/testimonials`, { token, body: { content: 'Great!' } });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error.code, 'VALIDATION_ERROR');

  const badRating = await h.request('POST', `${P}/admin/testimonials`, {
    token, body: { name: 'TST Author', content: 'Great!', rating: 9 },
  });
  assert.equal(badRating.status, 400);

  const ok = await h.request('POST', `${P}/admin/testimonials`, {
    token, body: { name: 'TST Author', content: 'Great!', rating: 5 },
  });
  assert.equal(ok.status, 201);
  track.testimonials.push(ok.body.data.id);
});

// ---------- Templates: server-side publish gate ----------
// The admin panel gates publish in the UI; these assert the same rules server-side,
// so a direct PATCH can't push an empty template live.
test('admin templates: publish is gated on bundle + thumbnail + anchor + size + tag', async () => {
  const token = h.adminToken(['*']);
  const stamp = Date.now();

  // A new template can never be complete — content/thumbnail are written by the bundle
  // flow, which needs the uid that create returns. So creating straight into `active` fails.
  const born = await h.request('POST', `${P}/admin/templates`, { token, body: { name: `TST Gate ${stamp}`, status: 'active' } });
  assert.equal(born.status, 400);
  assert.equal(born.body.error.code, 'VALIDATION_ERROR');

  const created = await h.request('POST', `${P}/admin/templates`, { token, body: { name: `TST Gate ${stamp}` } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.status, 'draft', 'templates are born as drafts');
  const tpl = created.body.data;
  track.templates.push(tpl.id);

  // Name only -> refused, with one details entry per unmet requirement.
  const blocked = await h.request('PATCH', `${P}/admin/templates/${tpl.uid}`, { token, body: { status: 'active' } });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(
    blocked.body.error.details.map((d) => d.field).sort(),
    ['category_id', 'content', 'size_ids', 'tag_ids', 'thumbnail_s3_key'],
  );

  // Un-publishing is never gated, even while incomplete.
  const down = await h.request('PATCH', `${P}/admin/templates/${tpl.uid}`, { token, body: { status: 'inactive' } });
  assert.equal(down.status, 200);

  const tag  = await models.Tag.create({ name: `TST Gate Tag ${stamp}`, slug: `tst-gate-tag-${stamp}` });
  track.tags.push(tag.id);
  const size = await models.TemplateSize.create({ uid: uuid(), name: `TST Gate Size ${stamp}`, slug: `tst-gate-size-${stamp}`, width: 1080, height: 1080 });
  track.templateSizes.push(size.id);

  const row = await Template.findByPk(tpl.id);
  await row.update({ content: '{"c":1}', thumbnail_s3_key: `templates/${tpl.uid}/cover.png` });
  await row.setTemplateSizes([size.id]);
  await row.setBusinessCategories([1]); // industry only, no category_id -> the "category OR industry" branch

  // Everything but the tag.
  const noTag = await h.request('PATCH', `${P}/admin/templates/${tpl.uid}`, { token, body: { status: 'active' } });
  assert.equal(noTag.status, 400);
  assert.deepEqual(noTag.body.error.details.map((d) => d.field), ['tag_ids']);

  await row.setTags([tag.id]);
  const published = await h.request('PATCH', `${P}/admin/templates/${tpl.uid}`, { token, body: { status: 'active' } });
  assert.equal(published.status, 200);
  assert.equal(published.body.data.status, 'active', 'publishes once complete (industry satisfies the anchor)');
});

test('admin templates: the anchor may be satisfied by category_id in the same request as status', async () => {
  const token = h.adminToken(['*']);
  const stamp = Date.now();

  const tpl = await Template.create({
    uid: uuid(), name: `TST Anchor ${stamp}`, content: '{"c":1}',
    thumbnail_s3_key: 'templates/x/thumb.png', status: 'draft',
  });
  track.templates.push(tpl.id);
  const tag = await models.Tag.create({ name: `TST Anchor Tag ${stamp}`, slug: `tst-anchor-tag-${stamp}` });
  track.tags.push(tag.id);
  const size = await models.TemplateSize.create({ uid: uuid(), name: `TST Anchor Size ${stamp}`, slug: `tst-anchor-size-${stamp}`, width: 720, height: 720 });
  track.templateSizes.push(size.id);
  await tpl.setTags([tag.id]);
  await tpl.setTemplateSizes([size.id]);

  // No category and no industry yet -> the anchor is the only thing missing.
  const blocked = await h.request('PATCH', `${P}/admin/templates/${tpl.uid}`, { token, body: { status: 'active' } });
  assert.equal(blocked.status, 400);
  assert.deepEqual(blocked.body.error.details.map((d) => d.field), ['category_id']);

  // Setting the category alongside status is judged on the post-update state, not the old row.
  const ok = await h.request('PATCH', `${P}/admin/templates/${tpl.uid}`, { token, body: { category_id: 2, status: 'active' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'active');
});

// ---------- Templates: admin list completeness signals ----------
test('admin template list carries tag/size/industry counts and bundle flags', async () => {
  const token = h.adminToken(['*']);
  const stamp = Date.now();

  const tpl = await Template.create({ uid: uuid(), name: `TST Counts ${stamp}`, content: '{"c":1}', status: 'draft', category_id: 2 });
  track.templates.push(tpl.id);
  const tag = await models.Tag.create({ name: `TST Counts Tag ${stamp}`, slug: `tst-counts-tag-${stamp}` });
  track.tags.push(tag.id);
  await tpl.setTags([tag.id]);
  await tpl.setBusinessCategories([1]);

  const list = await h.request('GET', `${P}/admin/templates?search=${encodeURIComponent(`TST Counts ${stamp}`)}`, { token });
  assert.equal(list.status, 200);
  const row = list.body.data.find((t) => t.uid === tpl.uid);
  assert.ok(row, 'template present in the admin list');
  assert.equal(Number(row.tag_count), 1);
  assert.equal(Number(row.size_count), 0, 'no sizes assigned -> not publishable');
  assert.equal(Number(row.industry_count), 1);
  assert.equal(Number(row.has_content), 1);
  assert.equal(Number(row.has_thumbnail), 0);
  assert.equal(row.content, undefined, 'heavy content blob still excluded from list rows');
  assert.equal(typeof list.body.meta.total, 'number');
});

// ---------- Templates: relations naming ----------
test('template relations return Industries (with BusinessCategories kept as a deprecated alias)', async () => {
  const token = h.adminToken(['*']);
  const tpl = await Template.create({ uid: uuid(), name: `TST Rel ${Date.now()}`, status: 'draft' });
  track.templates.push(tpl.id);

  // The PUT takes `industry_ids`...
  const put = await h.request('PUT', `${P}/admin/templates/${tpl.uid}/relations`, { token, body: { industry_ids: [1] } });
  assert.equal(put.status, 200);

  // ...and the GET now answers with the matching `Industries` key.
  const rel = await h.request('GET', `${P}/admin/templates/${tpl.uid}/relations`, { token });
  assert.equal(rel.status, 200);
  assert.equal(rel.body.data.Industries.length, 1);
  assert.equal(rel.body.data.Industries[0].id, 1);
  assert.deepEqual(rel.body.data.BusinessCategories, rel.body.data.Industries, 'deprecated alias mirrors it');
  assert.deepEqual(put.body.data.Industries, rel.body.data.Industries, 'PUT response has the same shape');
});

// ---------- Templates: thumbnail swap without re-uploading the bundle ----------
test('bundle/confirm accepts thumbnail_filename alone (no content) and rejects an empty body', async () => {
  const token = h.adminToken(['*']);
  const s3 = require('../src/utils/s3Helper');
  const original = { listKeys: s3.listKeys, putObjectTagging: s3.putObjectTagging };
  const tagged = [];
  s3.listKeys = async (prefix) => [`${prefix}cover.png`];
  s3.putObjectTagging = async (key, status) => { tagged.push([key, status]); };

  try {
    const tpl = await Template.create({ uid: uuid(), name: `TST Thumb ${Date.now()}`, content: '{"c":1}', status: 'draft' });
    track.templates.push(tpl.id);

    const empty = await h.request('POST', `${P}/admin/templates/${tpl.uid}/bundle/confirm`, { token, body: {} });
    assert.equal(empty.status, 400, 'at least one of content / thumbnail_filename is required');

    const res = await h.request('POST', `${P}/admin/templates/${tpl.uid}/bundle/confirm`, {
      token, body: { thumbnail_filename: 'cover.png' },
    });
    assert.equal(res.status, 200);

    await tpl.reload();
    assert.equal(tpl.thumbnail_s3_key, `templates/${tpl.uid}/cover.png`);
    assert.equal(tpl.content, '{"c":1}', 'existing bundle JSON left untouched');
    assert.deepEqual(tagged, [[`templates/${tpl.uid}/cover.png`, 'active']], 'the new object is flipped to active');
  } finally {
    Object.assign(s3, original);
  }
});
