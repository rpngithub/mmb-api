const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { v4: uuid } = require('uuid');
const h = require('./helpers');

const { models } = h;
const { User, Business, Template, UserSubscription, Payment, ActivityLog, OtpCode, UserSession } = models;
const { hashOtp } = require('../src/utils/otpHelper');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { JWT_SECRET } = require('../src/config/jwt');

const P = '/api/v1';
let startLogId = 0;
const track = { users: [], templates: [], variants: [], brandSeries: [], variantBadges: [], stylePersonalities: [], colors: [], faqCategories: [], faqs: [], testimonials: [], tags: [], templateSizes: [], businessCategories: [], templateCategories: [], assets: [], assetCategories: [], coupons: [], fonts: [] };

before(async () => {
  await models.sequelize.authenticate();
  await h.start();
  startLogId = (await ActivityLog.max('id')) || 0;
});

after(async () => {
  if (track.faqs.length)          await models.Faq.destroy({ where: { id: track.faqs } });
  if (track.faqCategories.length) await models.FaqCategory.destroy({ where: { id: track.faqCategories } });
  if (track.testimonials.length)  await models.Testimonial.destroy({ where: { id: track.testimonials } });
  if (track.variants.length)     await models.Variant.destroy({ where: { id: track.variants } });        // cascades joins
  if (track.brandSeries.length)  await models.BrandSeries.destroy({ where: { id: track.brandSeries } });  // cascades its taxonomy joins
  if (track.variantBadges.length)      await models.VariantBadge.destroy({ where: { id: track.variantBadges } });
  if (track.stylePersonalities.length) await models.StylePersonality.destroy({ where: { id: track.stylePersonalities } });
  if (track.colors.length)             await models.Color.destroy({ where: { id: track.colors } });
  if (track.templates.length) await Template.destroy({ where: { id: track.templates } }); // cascades template_tags / _sizes / _business_categories
  if (track.tags.length)              await models.Tag.destroy({ where: { id: track.tags } });
  if (track.templateSizes.length)     await models.TemplateSize.destroy({ where: { id: track.templateSizes } });
  if (track.businessCategories.length) await models.BusinessCategory.destroy({ where: { id: track.businessCategories } });
  if (track.templateCategories.length) await models.TemplateCategory.destroy({ where: { id: track.templateCategories } });
  if (track.assets.length)             await models.Asset.destroy({ where: { id: track.assets } });
  if (track.assetCategories.length)    await models.AssetCategory.destroy({ where: { id: track.assetCategories } });
  if (track.users.length)     await User.destroy({ where: { id: track.users } }); // cascades (incl. subscriptions)
  if (track.fonts.length)     await models.Font.destroy({ where: { id: track.fonts } }); // cascades files + languages
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

// The pricing card renders `display_label` verbatim, so it must never be null —
// most plan_features rows leave the admin override blank and rely on derivation.
test('GET /plans returns card-ready features: display_label never null, enabled flag set', async () => {
  const pro = await models.Plan.findOne({ where: { name: 'Pro' } });
  const mkType = (key, label, data_type) =>
    models.FeatureType.create({ key: `tst_${key}_${Date.now()}`, label, data_type, reset_period: 'never' });

  // Four rows with NO display_label, one per derivation branch.
  const [bOn, bOff, iCount, iZero, hidden] = await Promise.all([
    mkType('bon',    'WhatsApp Stickers',     'boolean'),
    mkType('boff',   'Monthly SM Calender',   'boolean'),
    mkType('icnt',   'AI BG remover credits', 'integer'),
    mkType('izero',  'SM Themes',             'integer'),
    mkType('hidden', 'Internal Only',         'integer'),
  ]);
  const rows = await models.PlanFeature.bulkCreate([
    { plan_id: pro.id, feature_type_id: bOn.id,    value: 1,   display_order: 11, show_on_card: 1 },
    { plan_id: pro.id, feature_type_id: bOff.id,   value: 0,   display_order: 12, show_on_card: 1 },
    { plan_id: pro.id, feature_type_id: iCount.id, value: 500, display_order: 13, show_on_card: 1 },
    { plan_id: pro.id, feature_type_id: iZero.id,  value: 0,   display_order: 14, show_on_card: 1 },
    // show_on_card=0 stays off the card entirely
    { plan_id: pro.id, feature_type_id: hidden.id, value: 99,  display_order: 15, show_on_card: 0 },
  ]);

  try {
    const r = await h.request('GET', `${P}/plans`);
    assert.equal(r.status, 200);
    const plan = r.body.data.find((p) => p.name === 'Pro');

    assert.equal(plan.PlanFeatures, undefined, 'raw join rows are not exposed');
    assert.ok(Array.isArray(plan.features));
    assert.ok(plan.features.every((f) => typeof f.display_label === 'string' && f.display_label.length),
      'every feature carries a renderable label');
    assert.deepEqual(
      plan.features.map((f) => f.display_order),
      [...plan.features.map((f) => f.display_order)].sort((a, b) => a - b),
      'ordered by display_order',
    );

    const by = (label) => plan.features.find((f) => f.label === label);
    // the seeded row keeps its explicit override
    assert.equal(by('Downloads').display_label, 'Unlimited downloads');
    assert.equal(by('Downloads').unlimited, true);

    assert.deepEqual(
      { display_label: by('WhatsApp Stickers').display_label, enabled: by('WhatsApp Stickers').enabled },
      { display_label: 'WhatsApp Stickers', enabled: true },
    );
    assert.deepEqual(
      { display_label: by('Monthly SM Calender').display_label, enabled: by('Monthly SM Calender').enabled },
      { display_label: 'Monthly SM Calender', enabled: false },
    );
    assert.deepEqual(
      { display_label: by('AI BG remover credits').display_label, enabled: by('AI BG remover credits').enabled },
      { display_label: '500 AI BG remover credits', enabled: true },
    );
    assert.deepEqual(
      { display_label: by('SM Themes').display_label, enabled: by('SM Themes').enabled },
      { display_label: 'SM Themes', enabled: false },
    );

    assert.equal(by('Internal Only'), undefined, 'show_on_card=0 is excluded');
    // internal join columns stay server-side
    assert.deepEqual(Object.keys(by('SM Themes')).sort(),
      ['data_type', 'display_label', 'display_order', 'enabled', 'key', 'label', 'unlimited', 'value']);
  } finally {
    await models.PlanFeature.destroy({ where: { id: rows.map((x) => x.id) } });
    await models.FeatureType.destroy({ where: { id: [bOn.id, bOff.id, iCount.id, iZero.id, hidden.id] } });
  }
});

// ---------- Auth ----------
test('OTP login: send-otp then verify-otp issues tokens with free tier', async () => {
  const phone = `9${String(Date.now() % 1000000000).padStart(9, '0')}`;
  const send = await h.request('POST', `${P}/auth/send-otp`, { body: { phone, purpose: 'login' } });
  assert.equal(send.status, 200);
  assert.match(String(send.body.data.otp), /^\d{6}$/, 'otp exposed in test env');

  const verify = await h.request('POST', `${P}/auth/verify-otp`, {
    body: { phone, otp: send.body.data.otp, purpose: 'login', client_mnemonic: 'android' },
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
  const phone = `9${String((Date.now() + 7) % 1000000000).padStart(9, '0')}`;
  await h.request('POST', `${P}/auth/send-otp`, { body: { phone, purpose: 'login' } });
  const verify = await h.request('POST', `${P}/auth/verify-otp`, {
    body: { phone, otp: '000000', purpose: 'login', client_mnemonic: 'android' },
  });
  assert.equal(verify.status, 401);
  const u = await User.findOne({ where: { phone } });
  if (u) track.users.push(u.id);
});

// `client_mnemonic` was free text landing in a JWT claim and a STRING(50) column.
// The value nothing gates on today is the value something gates on tomorrow, and a
// user-side login must not be able to call itself the admin panel.
test('verify-otp only accepts known clients, and admin_panel is not one of them', async () => {
  const phone = newPhone();
  const sent  = await h.request('POST', `${P}/auth/send-otp`, { body: { phone, purpose: 'login' } });

  const reject = (client) => h.request('POST', `${P}/auth/verify-otp`, {
    body: { phone, otp: sent.body.data.otp, purpose: 'login', client_mnemonic: client },
  });

  assert.equal((await reject('admin_panel')).status, 400, 'a user cannot claim to be the admin panel');
  assert.equal((await reject('whatever-i-like')).status, 400);
  assert.equal((await reject('Android')).status, 400, 'matched exactly, so case matters');
  // Used to reach the INSERT and 500 on a STRING(50) column, after burning the OTP.
  assert.equal((await reject('x'.repeat(200))).status, 400);

  // The OTP survived all of that, so a real client can still finish the login.
  const ok = await h.request('POST', `${P}/auth/verify-otp`, {
    body: { phone, otp: sent.body.data.otp, purpose: 'login', client_mnemonic: 'ios' },
  });
  assert.equal(ok.status, 200);
  assert.equal(
    JSON.parse(Buffer.from(ok.body.data.access_token.split('.')[1], 'base64').toString()).client_type,
    'ios', 'the accepted value is what lands in the token',
  );

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

  // `sid` survives a refresh: rotation keeps the same session row, so the session
  // an access token names stays live for the life of the login. (It used to change
  // every refresh, because each one revoked the old session and opened a new one.)
  assert.equal(refreshClaims.sid, loginClaims.sid, 'refresh rotates in place, keeping the session');

  // Same claim set, ignoring the claims that differ per token by design: jti/iat/exp.
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

// ---------- Variant premium (plan-scoped) gating ----------

// Create a user holding an ACTIVE subscription on the given plan; returns the user id.
async function userWithActivePlan(planId, salt) {
  const user = await User.create({ uid: uuid(), name: 'TST Sub User', phone: `9${String((Date.now() + salt) % 1000000000).padStart(9, '0')}` });
  track.users.push(user.id);
  await UserSubscription.create({
    uid: uuid(), user_id: user.id, plan_id: planId, sub_type: 'regular', status: 'active',
    starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 299,
  });
  return user.id;
}

// A brand series + one variant inside it, both tracked for cleanup.
async function makeSeriesWithVariant(label, variantAttrs = {}) {
  const series = await models.BrandSeries.create({ uid: uuid(), name: `TST ${label} Series`, is_active: 1 });
  track.brandSeries.push(series.id);
  const variant = await models.Variant.create({
    uid: uuid(), series_id: series.id, name: `TST ${label} Variant`, is_active: 1, ...variantAttrs,
  });
  track.variants.push(variant.id);
  return { series, variant };
}

test('variant detail: card is public and templates are always listed, but locked ones are stripped', async () => {
  const { variant } = await makeSeriesWithVariant('Pro', { description: 'Premium variant', likes_count: 42 });
  const tpl = await Template.create({ uid: uuid(), name: 'TST Variant Tpl', content: '{"a":1}', status: 'active' });
  track.templates.push(tpl.id);
  await variant.setTemplates([tpl.id]);
  await variant.setPlans([2]);                 // entitled: Pro (plan id 2)
  await variant.setBusinessCategories([1, 5]); // display tags

  // guest -> card visible, templates LISTED but without content, entitlement set hidden
  const guest = await h.request('GET', `${P}/variants/${variant.uid}`);
  assert.equal(guest.status, 200);
  assert.equal(guest.body.data.is_locked, true);
  assert.equal(guest.body.data.Templates.length, 1, 'locked templates are shown as upsell teasers');
  assert.equal(guest.body.data.Templates[0].is_locked, true);
  assert.equal(guest.body.data.Templates[0].content, undefined, 'design payload withheld while locked');
  assert.ok('thumbnail_s3_key' in guest.body.data.Templates[0], 'thumbnail still exposed');
  assert.equal(guest.body.data.templates_count, 1);
  assert.equal(guest.body.data.description, 'Premium variant');
  assert.equal(guest.body.data.likes_count, 42);
  assert.equal(guest.body.data.BusinessCategories.length, 2, 'industry tags on the card');
  assert.equal(guest.body.data.Plans, undefined, 'entitlement set never exposed');

  // user with an ACTIVE Pro subscription -> entitled, templates (with content) served
  const proUserId = await userWithActivePlan(2, 11);
  const entitled = await h.request('GET', `${P}/variants/${variant.uid}`, { token: h.userTokenFor(proUserId, 'paid') });
  assert.equal(entitled.body.data.is_locked, false);
  assert.equal(entitled.body.data.Templates.length, 1);
  assert.equal(entitled.body.data.Templates[0].is_locked, false);
  assert.equal(typeof entitled.body.data.Templates[0].content, 'string', 'content served to entitled viewer');

  // user on a DIFFERENT plan (Free, id 1) -> locked (proves plan-scoping, not just "any paid")
  const freeUserId = await userWithActivePlan(1, 22);
  const wrongPlan = await h.request('GET', `${P}/variants/${variant.uid}`, { token: h.userTokenFor(freeUserId, 'paid') });
  assert.equal(wrongPlan.body.data.is_locked, true, 'plan not in the variant allowlist -> locked');
  assert.equal(wrongPlan.body.data.Templates[0].content, undefined);
});

test('variant with no plan restrictions is locked to everyone (incl. subscribers)', async () => {
  const { variant } = await makeSeriesWithVariant('Unrestricted');
  const tpl = await Template.create({ uid: uuid(), name: 'TST T2', content: '{}', status: 'active' });
  track.templates.push(tpl.id);
  await variant.setTemplates([tpl.id]); // no setPlans -> no rows -> nobody

  const proUserId = await userWithActivePlan(2, 33);
  const r = await h.request('GET', `${P}/variants/${variant.uid}`, { token: h.userTokenFor(proUserId, 'paid') });
  assert.equal(r.body.data.is_locked, true);
  assert.equal(r.body.data.Templates[0].content, undefined);
});

test('brand series list: counts, rollup lock state and the variant preview slice', async () => {
  const { series, variant } = await makeSeriesWithVariant('Counts');
  const second = await models.Variant.create({ uid: uuid(), series_id: series.id, name: 'TST Counts Variant 2', is_active: 1 });
  track.variants.push(second.id);

  const shared = await Template.create({ uid: uuid(), name: 'TST Shared Tpl', content: '{}', status: 'active' });
  const only   = await Template.create({ uid: uuid(), name: 'TST Only Tpl',   content: '{}', status: 'active' });
  track.templates.push(shared.id, only.id);
  await variant.setTemplates([shared.id, only.id]);
  await second.setTemplates([shared.id]);          // shared across both variants of the series
  await variant.setPlans([2]);

  const guest = await h.request('GET', `${P}/brand-series`);
  assert.equal(guest.status, 200);
  const row = guest.body.data.find((x) => x.uid === series.uid);
  assert.ok(row, 'series present in the public list');
  assert.equal(row.variants_count, 2);
  assert.equal(row.templates_count, 2, 'DISTINCT across variants - the shared template counts once');
  assert.equal(row.unlocked_variants_count, 0);
  assert.equal(row.is_locked, true, 'no variant unlocked -> series reads as locked');
  assert.equal(row.Variants.length, 2, 'preview defaults to 4, so both are returned');
  assert.equal(row.Variants[0].templates_count, 2, 'per-variant tally on the card');

  // an entitled viewer flips the rollup: one of two variants opens
  const proUserId = await userWithActivePlan(2, 44);
  const paid = await h.request('GET', `${P}/brand-series`, { token: h.userTokenFor(proUserId, 'paid') });
  const paidRow = paid.body.data.find((x) => x.uid === series.uid);
  assert.equal(paidRow.unlocked_variants_count, 1);
  assert.equal(paidRow.is_locked, false, 'partially unlocked series is not locked');

  // preview_variants=0 returns the counts without the nested cards
  const none = await h.request('GET', `${P}/brand-series?preview_variants=0`);
  const noneRow = none.body.data.find((x) => x.uid === series.uid);
  assert.equal(noneRow.Variants.length, 0);
  assert.equal(noneRow.variants_count, 2, 'count is independent of the preview slice');
});

test('brand series carry style personalities, tags and colours in display order', async () => {
  const stamp = Date.now();
  const series = await models.BrandSeries.create({
    uid: uuid(), name: `TST Descriptive ${stamp}`, caption: 'Bright ideas deserve bright branding',
    description: 'Fresh, vibrant, energetic visuals.', is_active: 1,
  });
  track.brandSeries.push(series.id);

  const bold  = await models.StylePersonality.create({ uid: uuid(), name: `TST Bold ${stamp}`,  slug: `tst-bold-${stamp}` });
  const fresh = await models.StylePersonality.create({ uid: uuid(), name: `TST Fresh ${stamp}`, slug: `tst-fresh-${stamp}` });
  track.stylePersonalities.push(bold.id, fresh.id);
  const gold  = await models.Color.create({ uid: uuid(), name: `TST Gold ${stamp}`,  slug: `tst-gold-${stamp}`,  hex_code: '#D4AF37' });
  const black = await models.Color.create({ uid: uuid(), name: `TST Black ${stamp}`, slug: `tst-black-${stamp}`, hex_code: '#000000' });
  track.colors.push(gold.id, black.id);
  const tag = await models.Tag.create({ name: `TST Series Tag ${stamp}`, slug: `tst-series-tag-${stamp}` });
  track.tags.push(tag.id);

  const token = h.adminToken(['brand_series.*']);
  // deliberately fresh-then-bold and black-then-gold: array order IS the display order
  const set = await h.request('PUT', `${P}/admin/brand-series/${series.uid}/relations`, {
    token,
    body: { style_personality_ids: [fresh.id, bold.id], tag_ids: [tag.id], color_ids: [black.id, gold.id] },
  });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.data.StylePersonalities.map((x) => x.id), [fresh.id, bold.id]);
  assert.deepEqual(set.body.data.Colors.map((x) => x.id), [black.id, gold.id]);
  assert.equal(set.body.data.Tags.length, 1);

  // and the public list serves the same order, with the hex code alongside the name
  const pub = await h.request('GET', `${P}/brand-series`);
  const row = pub.body.data.find((x) => x.uid === series.uid);
  assert.equal(row.caption, 'Bright ideas deserve bright branding');
  assert.deepEqual(row.StylePersonalities.map((x) => x.id), [fresh.id, bold.id]);
  assert.deepEqual(row.Colors.map((x) => x.hex_code), ['#000000', '#D4AF37']);

  const bad = await h.request('PUT', `${P}/admin/brand-series/${series.uid}/relations`, { token, body: {} });
  assert.equal(bad.status, 400, 'empty body rejected by the relations validator');
});

test('a variant carries at most one badge, exposed with its icon', async () => {
  const stamp = Date.now();
  const badge = await models.VariantBadge.create({
    uid: uuid(), name: `TST Popular ${stamp}`, slug: `tst-popular-${stamp}`, icon_s3_key: 'variants/badge-icon/x.png', is_active: 1,
  });
  track.variantBadges.push(badge.id);
  const { variant } = await makeSeriesWithVariant('Badged', { badge_id: badge.id });

  const r = await h.request('GET', `${P}/variants/${variant.uid}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.VariantBadge.name, `TST Popular ${stamp}`);
  assert.equal(r.body.data.VariantBadge.icon_s3_key, 'variants/badge-icon/x.png');
});

test('deprecated theme routes still answer, and say so in the headers', async () => {
  const { variant } = await makeSeriesWithVariant('Deprecated');

  const groups = await h.request('GET', `${P}/theme-groups`);
  assert.equal(groups.status, 200);
  assert.equal(groups.headers.deprecation, 'true');
  assert.match(groups.headers.link, /rel="successor-version"/);
  assert.match(groups.headers.link, /brand-series/);

  const detail = await h.request('GET', `${P}/themes/${variant.uid}`);
  assert.equal(detail.status, 200, 'old variant-detail path still serves');
  assert.equal(detail.body.data.uid, variant.uid);
  assert.equal(detail.headers.deprecation, 'true');
});

test('public /templates no longer exposes variant templates (variant_id is not an anchor)', async () => {
  const r = await h.request('GET', `${P}/templates?variant_id=1`);
  assert.equal(r.status, 400, 'variant_id alone is not a valid anchor');
  const legacy = await h.request('GET', `${P}/templates?theme_id=1`);
  assert.equal(legacy.status, 400, 'the deprecated theme_id alias is not an anchor either');
});

test('admin variant relations: set plan entitlements + industries, read back', async () => {
  const token = h.adminToken(['variants.*']);
  const { variant } = await makeSeriesWithVariant('Rel');

  const set = await h.request('PUT', `${P}/admin/variants/${variant.uid}/relations`, {
    token, body: { plan_ids: [2], business_category_ids: [1, 5] },
  });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.Plans.length, 1);
  assert.equal(set.body.data.BusinessCategories.length, 2);
  assert.equal(set.body.data.Industries.length, 2, 'industries mirrored under the public name');

  const get = await h.request('GET', `${P}/admin/variants/${variant.uid}/relations`, { token });
  assert.equal(get.status, 200);
  assert.equal(get.body.data.Plans[0].id, 2);

  // empty body is rejected by the relations validator
  const bad = await h.request('PUT', `${P}/admin/variants/${variant.uid}/relations`, { token, body: {} });
  assert.equal(bad.status, 400);

  // the pre-rename admin path still works, for clients that have not migrated
  const old = await h.request('GET', `${P}/admin/themes/${variant.uid}/relations`, { token });
  assert.equal(old.status, 200);
  assert.equal(old.headers.deprecation, 'true');
});

// ---------- "Use This Brand Series" (variant adoption) ----------
test('add to your business: only an entitled owner can adopt; adoption is durable', async () => {
  const { variant } = await makeSeriesWithVariant('Adopt');
  const tpl = await Template.create({ uid: uuid(), name: 'TST Adopt Tpl', content: '{"z":1}', status: 'active', category_id: 1 });
  track.templates.push(tpl.id);
  await variant.setTemplates([tpl.id]);
  await variant.setPlans([2]); // Pro-only

  const ownerId = (await User.create({ uid: uuid(), name: 'TST Owner', phone: `9${String((Date.now() + 41) % 1000000000).padStart(9, '0')}` })).id;
  track.users.push(ownerId);
  const biz = await Business.create({ uid: uuid(), user_id: ownerId, name: 'TST Biz', is_active: 1 });
  const ownerTok = h.userTokenFor(ownerId, 'free');

  // no entitling plan -> cannot adopt
  const denied = await h.request('POST', `${P}/businesses/${biz.uid}/variants`, { token: ownerTok, body: { variant_uid: variant.uid } });
  assert.equal(denied.status, 403);

  // grant active Pro -> can adopt
  const sub = await UserSubscription.create({
    uid: uuid(), user_id: ownerId, plan_id: 2, sub_type: 'regular', status: 'active',
    starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 299,
  });
  const adopt = await h.request('POST', `${P}/businesses/${biz.uid}/variants`, { token: ownerTok, body: { variant_uid: variant.uid } });
  assert.equal(adopt.status, 201);
  assert.equal(adopt.body.data.Templates.length, 1);

  // listed in the collection, and idempotent (no duplicate on re-adopt)
  await h.request('POST', `${P}/businesses/${biz.uid}/variants`, { token: ownerTok, body: { variant_uid: variant.uid } });
  const listed = await h.request('GET', `${P}/businesses/${biz.uid}/variants`, { token: ownerTok });
  assert.equal(listed.body.data.length, 1);
  assert.equal(listed.body.data[0].uid, variant.uid);

  // DURABLE: the plan lapses, but the adopted variant stays unlocked...
  await sub.update({ status: 'expired' });
  const detail = await h.request('GET', `${P}/variants/${variant.uid}`, { token: ownerTok });
  assert.equal(detail.body.data.is_locked, false, 'adopted variant stays unlocked after lapse');
  assert.equal(typeof detail.body.data.Templates[0].content, 'string', 'and its content is served');
  // ...and its template can still be turned into a project
  const proj = await h.request('POST', `${P}/projects`, { token: ownerTok, body: { name: 'From adopted', template_id: tpl.id, content: '{"z":1}' } });
  assert.equal(proj.status, 201);

  // remove adoption -> re-locks (no sub, no adoption)
  const del = await h.request('DELETE', `${P}/businesses/${biz.uid}/variants/${variant.uid}`, { token: ownerTok });
  assert.equal(del.status, 200);
  const relocked = await h.request('GET', `${P}/variants/${variant.uid}`, { token: ownerTok });
  assert.equal(relocked.body.data.is_locked, true);
});

test('adoption is per-variant: it does not unlock siblings in the same brand series', async () => {
  const { series, variant } = await makeSeriesWithVariant('Sibling');
  const sibling = await models.Variant.create({ uid: uuid(), series_id: series.id, name: 'TST Sibling Variant 2', is_active: 1 });
  track.variants.push(sibling.id);
  await variant.setPlans([2]);
  await sibling.setPlans([2]);

  const ownerId = (await User.create({ uid: uuid(), name: 'TST Sib Owner', phone: `9${String((Date.now() + 63) % 1000000000).padStart(9, '0')}` })).id;
  track.users.push(ownerId);
  const biz = await Business.create({ uid: uuid(), user_id: ownerId, name: 'TST Sib Biz', is_active: 1 });
  const ownerTok = h.userTokenFor(ownerId, 'free');
  const sub = await UserSubscription.create({
    uid: uuid(), user_id: ownerId, plan_id: 2, sub_type: 'regular', status: 'active',
    starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 299,
  });

  await h.request('POST', `${P}/businesses/${biz.uid}/variants`, { token: ownerTok, body: { variant_uid: variant.uid } });
  await sub.update({ status: 'expired' });   // entitlement gone; only the adoption remains

  const adopted = await h.request('GET', `${P}/variants/${variant.uid}`, { token: ownerTok });
  assert.equal(adopted.body.data.is_locked, false, 'the adopted variant is open');
  const other = await h.request('GET', `${P}/variants/${sibling.uid}`, { token: ownerTok });
  assert.equal(other.body.data.is_locked, true, 'its sibling in the same series stays locked');
});

test('variant templates never surface in the public catalog (category browse + direct fetch + project)', async () => {
  const { variant } = await makeSeriesWithVariant('Leak');
  // a variant template that ALSO carries a public category and is not is_premium — must still be hidden
  const tpl = await Template.create({ uid: uuid(), name: 'TST Leak Tpl', content: '{"c":1}', status: 'active', category_id: 2, is_premium: 0 });
  track.templates.push(tpl.id);
  await variant.setTemplates([tpl.id]);
  await variant.setPlans([2]);

  const browse = await h.request('GET', `${P}/templates?category_id=2`);
  assert.equal(browse.status, 200);
  assert.ok(!browse.body.data.some((t) => t.uid === tpl.uid), 'variant template excluded from category browse');

  const direct = await h.request('GET', `${P}/templates/${tpl.uid}`);
  assert.equal(direct.status, 404, 'variant template hidden from the public template endpoint');

  const freeId = (await User.create({ uid: uuid(), name: 'TST Free', phone: `9${String((Date.now() + 52) % 1000000000).padStart(9, '0')}` })).id;
  track.users.push(freeId);
  const proj = await h.request('POST', `${P}/projects`, { token: h.userTokenFor(freeId), body: { name: 'x', template_id: tpl.id, content: '{}' } });
  assert.equal(proj.status, 403, 'non-entitled/non-adopted user cannot project a variant template');
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

test('industries?tree nests parent→child; ?hierarchy returns top-level only', async () => {
  const stamp = Date.now();
  // root → mid → two leaves (display_order 2 created before 1, to prove sorting)
  const root  = await models.BusinessCategory.create({ uid: uuid(), parent_id: null,   name: `TST IRoot ${stamp}`,  slug: `tst-iroot-${stamp}`,  display_order: 0, is_active: 1 });
  const mid   = await models.BusinessCategory.create({ uid: uuid(), parent_id: root.id, name: `TST IMid ${stamp}`,   slug: `tst-imid-${stamp}`,   display_order: 0, is_active: 1 });
  const leafB = await models.BusinessCategory.create({ uid: uuid(), parent_id: mid.id,  name: `TST ILeafB ${stamp}`, slug: `tst-ileafb-${stamp}`, display_order: 2, is_active: 1 });
  const leafA = await models.BusinessCategory.create({ uid: uuid(), parent_id: mid.id,  name: `TST ILeafA ${stamp}`, slug: `tst-ileafa-${stamp}`, display_order: 1, is_active: 1 });
  track.businessCategories.push(leafA.id, leafB.id, mid.id, root.id); // children before parents for FK-safe teardown

  const tree = await h.request('GET', `${P}/industries?tree=1`);
  assert.equal(tree.status, 200);
  const rootNode = tree.body.data.find((c) => c.uid === root.uid);
  assert.ok(rootNode, 'root present at top level');
  const midNode = rootNode.children[0];
  assert.equal(midNode.uid, mid.uid, 'mid nested under root');
  assert.deepEqual(midNode.children.map((c) => c.uid), [leafA.uid, leafB.uid], 'leaves ordered by display_order ASC');
  assert.ok(!tree.body.data.some((c) => c.uid === mid.uid || c.uid === leafA.uid), 'nested nodes not surfaced as roots');

  const top = await h.request('GET', `${P}/industries?hierarchy=1`);
  assert.equal(top.status, 200);
  assert.ok(top.body.data.some((c) => c.uid === root.uid), 'top-level industry present');
  assert.ok(!top.body.data.some((c) => c.uid === mid.uid || c.uid === leafA.uid), 'children excluded');
  assert.ok(top.body.data.every((c) => c.parent_id === null), 'every row is a root');
  assert.ok(top.body.data.every((c) => c.children === undefined), 'flat — no children arrays');

  // the shape switches win over the flat parent filter, and tree wins over hierarchy
  const both = await h.request('GET', `${P}/industries?tree=1&hierarchy=1&parent=${mid.uid}`);
  assert.ok(both.body.data.find((c) => c.uid === root.uid)?.children.length, 'tree takes precedence');

  // the deprecated alias behaves identically
  const alias = await h.request('GET', `${P}/business-categories?hierarchy=1`);
  assert.ok(alias.body.data.every((c) => c.parent_id === null), 'alias honours hierarchy');
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
  const forbidden = await h.request('PATCH', `${P}/admin/template-categories/reorder`, { token: h.adminToken(['variants.*']), body: { ids: [parent.uid] } });
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
  assert.ok(String(imp.body).includes('icon_s3_key,thumbnail_s3_key'), 'image columns are in the header');
  assert.match(String(imp.body), /icon_s3_key -> categories\/business\/icon\//, 'help spells out the expected S3 prefix');
  assert.ok(!/REFERENCE-ONLY/.test(String(imp.body)), 'import template is not the reference file');

  const ref = await h.request('GET', `${P}/admin/imports/industries/template?example=1`, { token });
  assert.equal(ref.status, 200);
  assert.ok(/REFERENCE-ONLY/.test(String(ref.body)), 'reference file carries the sentinel');

  // permission gate on the template download
  const forbidden = await h.request('GET', `${P}/admin/imports/industries/template`, { token: h.adminToken(['variants.*']) });
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
  const forbidden = await importCsv('industries', 'name\nX', { token: h.adminToken(['variants.*']) });
  assert.equal(forbidden.status, 403);
});

// Image (S3 key) columns. `objectExists`/`putObjectTagging` are stubbed so the
// suite never talks to S3: the fake bucket holds exactly the keys in `present`,
// and every tag write is recorded on `tagged` for assertions.
async function withS3Objects(present, fn) {
  const s3 = require('../src/utils/s3Helper');
  const original = { objectExists: s3.objectExists, putObjectTagging: s3.putObjectTagging };
  const tagged = [];
  s3.objectExists = async (key) => (
    Object.prototype.hasOwnProperty.call(present, key)
      ? { exists: true, content_type: 'image/png', size: 1024, ...present[key] }
      : { exists: false }
  );
  s3.putObjectTagging = async (key, status) => { tagged.push([key, status]); };
  try { return { result: await fn(), tagged }; } finally { Object.assign(s3, original); }
}

test('import industries: stores image keys, and reports bad ones as warnings without skipping', async () => {
  const stamp = Date.now();
  const good = `IMP Img ${stamp}`;
  const bad  = `IMP BadImg ${stamp}`;
  const dup  = `IMP DupImg ${stamp}`;
  const iconKey  = `categories/business/icon/imp-${stamp}.png`;
  const thumbKey = `categories/business/thumbnail/imp-${stamp}.png`;
  const csv = [
    'name,parent,slug,icon_s3_key,thumbnail_s3_key,display_order,is_active,tags',
    // a full console URL must be trimmed down to the bare key
    `${good},,,https://test-bucket.s3.ap-south-1.amazonaws.com/${iconKey},${thumbKey},1,1,`,
    // wrong prefix + not an image extension + missing from the bucket -> 3 warnings, still imported
    `${bad},,,categories/template/icon/wrong-${stamp}.pdf,,2,1,`,
    // same icon as the first row -> reuse warning
    `${dup},,,${iconKey},,3,1,`,
  ].join('\n');

  const { result: res, tagged } = await withS3Objects(
    { [iconKey]: {}, [thumbKey]: {} },
    () => importCsv('industries', csv, { token: h.adminToken(['categories.*']) }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.data.summary.created, 3, 'image problems never skip a row');
  assert.equal(res.body.data.summary.skipped, 0);

  const rows = res.body.data.rows;
  assert.deepEqual(rows.find((r) => r.name === good).warnings, [], 'clean row carries no warnings');
  const badWarnings = rows.find((r) => r.name === bad).warnings.join(' | ');
  assert.match(badWarnings, /expected a key under 'categories\/business\/icon\/'/);
  assert.match(badWarnings, /not an image type/);
  assert.match(badWarnings, /no such object in S3/);
  assert.match(rows.find((r) => r.name === dup).warnings.join(' | '), /also used on line/);
  assert.equal(res.body.data.summary.warnings, 2);

  const saved = await models.BusinessCategory.findOne({ where: { name: good } });
  assert.equal(saved.icon_s3_key, iconKey, 'pasted URL normalized to the bare key');
  assert.equal(saved.thumbnail_s3_key, thumbKey);

  // every image now referenced by a record is flipped to status=active; the key
  // that does not exist in the bucket is not tagged (it would only 404)
  assert.deepEqual(
    tagged.map(([k]) => k).sort(),
    [iconKey, thumbKey].sort(),
    'live images tagged active, missing one skipped',
  );
  assert.ok(tagged.every(([, status]) => status === 'active'));

  const created = await models.BusinessCategory.findAll({ where: { name: [good, bad, dup] } });
  track.businessCategories.push(...created.map((c) => c.id));

  // blank leaves the stored image alone; NONE clears it
  const again = [
    'name,parent,slug,icon_s3_key,thumbnail_s3_key,display_order,is_active,tags',
    `${good},,,,NONE,1,1,`,
  ].join('\n');
  const { result: res2 } = await withS3Objects({ [iconKey]: {} }, () => importCsv('industries', again, { token: h.adminToken(['categories.*']) }));
  assert.equal(res2.body.data.summary.updated, 1);
  await saved.reload();
  assert.equal(saved.icon_s3_key, iconKey, 'blank cell keeps the existing image');
  assert.equal(saved.thumbnail_s3_key, null, 'NONE clears the image');
});

test('import: an unverifiable bucket degrades to shape checks with a note', async () => {
  const s3 = require('../src/utils/s3Helper');
  const original = { objectExists: s3.objectExists, putObjectTagging: s3.putObjectTagging };
  s3.objectExists = async () => null;               // "could not check"
  s3.putObjectTagging = async () => { throw new Error('no bucket'); };
  const stamp = Date.now();
  const name = `IMP NoBucket ${stamp}`;
  const csv = [
    'name,parent,slug,icon_s3_key,thumbnail_s3_key,display_order,is_active,tags',
    `${name},,,categories/business/icon/nb-${stamp}.png,,1,1,`,
  ].join('\n');
  try {
    const res = await importCsv('industries', csv, { token: h.adminToken(['categories.*']) });
    assert.equal(res.body.data.summary.created, 1, 'row still imports');
    assert.deepEqual(res.body.data.rows[0].warnings, [], 'no missing-object warning when the check is inconclusive');
    const notes = res.body.data.notes.join(' ');
    assert.match(notes, /could not be verified/);
    assert.match(notes, /could not be tagged status=active/, 'a failing tag write is a note, not an error');
  } finally { Object.assign(s3, original); }
  const row = await models.BusinessCategory.findOne({ where: { name } });
  if (row) track.businessCategories.push(row.id);
});

test('import: a dry run writes no S3 tags', async () => {
  const stamp = Date.now();
  const iconKey = `categories/business/icon/dry-${stamp}.png`;
  const csv = [
    'name,parent,slug,icon_s3_key,thumbnail_s3_key,display_order,is_active,tags',
    `IMP DryImg ${stamp},,,${iconKey},,1,1,`,
  ].join('\n');
  const { result: res, tagged } = await withS3Objects(
    { [iconKey]: {} },
    () => importCsv('industries', csv, { token: h.adminToken(['categories.*']), dryRun: true }),
  );
  assert.equal(res.body.data.summary.created, 1);
  assert.deepEqual(tagged, [], 'dry run touches nothing in S3');
});

test('import variants: upserts variants and auto-creates the brand series', async () => {
  const stamp = Date.now();
  const seriesName = `IMP Series ${stamp}`;
  const csv = [
    'series,name,description,display_order,is_active',
    `${seriesName},IMP Variant A ${stamp},desc a,1,1`,
    `${seriesName},IMP Variant B ${stamp},,2,1`,
  ].join('\n');
  const res = await importCsv('variants', csv, { token: h.adminToken(['variants.*']) });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.summary.created, 2);

  const series = await models.BrandSeries.findOne({ where: { name: seriesName } });
  assert.ok(series, 'brand series auto-created on the fly');
  const variants = await models.Variant.findAll({ where: { series_id: series.id } });
  assert.equal(variants.length, 2, 'both variants linked to the new series');
  track.variants.push(...variants.map((v) => v.id));
  track.brandSeries.push(series.id);
});

test('import variants: series_icon_s3_key sets the new series icon but never overwrites one', async () => {
  const token = h.adminToken(['variants.*']);
  const stamp = Date.now();
  const seriesName = `IMP IconSeries ${stamp}`;
  const iconA = `brand-series/icon/a-${stamp}.svg`;
  const iconB = `brand-series/icon/b-${stamp}.svg`;
  const thumb = `variants/thumbnail/v-${stamp}.png`;
  const present = { [iconA]: {}, [iconB]: {}, [thumb]: {} };

  const csv = (icon) => [
    'series,series_icon_s3_key,name,description,thumbnail_s3_key,display_order,is_active',
    `${seriesName},${icon},IMP IconVariant ${stamp},,${thumb},1,1`,
  ].join('\n');

  const { result: res, tagged } = await withS3Objects(present, () => importCsv('variants', csv(iconA), { token }));
  assert.equal(res.body.data.summary.created, 1);
  assert.deepEqual(tagged.map(([k]) => k).sort(), [iconA, thumb].sort(), 'series icon and variant thumbnail both tagged active');
  const series = await models.BrandSeries.findOne({ where: { name: seriesName } });
  assert.equal(series.icon_s3_key, iconA, 'icon applied when the series is created');
  const variant = await models.Variant.findOne({ where: { series_id: series.id } });
  assert.equal(variant.thumbnail_s3_key, thumb);
  track.variants.push(variant.id);
  track.brandSeries.push(series.id);

  // a later file pointing the same series at a different icon warns and changes nothing
  const { result: res2, tagged: tagged2 } = await withS3Objects(present, () => importCsv('variants', csv(iconB), { token }));
  assert.equal(res2.body.data.summary.updated, 1);
  assert.match(res2.body.data.rows[0].warnings.join(' | '), /already has an icon/);
  assert.ok(!tagged2.some(([k]) => k === iconB), 'an icon that was not applied is not tagged');
  await series.reload();
  assert.equal(series.icon_s3_key, iconA, 'existing series icon left alone');
});

test('import: the pre-rename `themes` entity key still resolves to variants', async () => {
  const stamp = Date.now();
  const seriesName = `IMP Legacy Series ${stamp}`;
  const csv = [
    'series,name,description,display_order,is_active',
    `${seriesName},IMP Legacy Variant ${stamp},via the old key,1,1`,
  ].join('\n');
  const res = await importCsv('themes', csv, { token: h.adminToken(['variants.*']) });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.summary.created, 1);

  const series = await models.BrandSeries.findOne({ where: { name: seriesName } });
  assert.ok(series, 'old key writes into the renamed tables');
  const variants = await models.Variant.findAll({ where: { series_id: series.id } });
  track.variants.push(...variants.map((v) => v.id));
  track.brandSeries.push(series.id);
});

test('import asset-categories: creates a tree, then updates on re-import', async () => {
  const token = h.adminToken(['assets.*']);
  const stamp = Date.now();
  const parentName = `IMP AssetCat ${stamp}`;
  const childName  = `IMP AssetSubCat ${stamp}`;
  const csv = [
    'name,parent,slug,display_order,is_active',
    `${childName},${parentName},imp-assetsub-${stamp},2,1`,   // child first
    `${parentName},,imp-assetcat-${stamp},1,1`,
  ].join('\n');

  const res = await importCsv('asset-categories', csv, { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.summary.created, 2);

  const parent = await models.AssetCategory.findOne({ where: { name: parentName } });
  const child  = await models.AssetCategory.findOne({ where: { name: childName } });
  assert.ok(parent && child, 'both categories created');
  assert.equal(child.parent_id, parent.id, 'child linked to a parent defined later in the file');
  track.assetCategories.push(child.id, parent.id);

  const again = await importCsv('asset-categories', csv, { token });
  assert.equal(again.body.data.summary.updated, 2, 're-import updates in place');
  assert.equal(again.body.data.summary.created, 0);
});

test('import assets: resolves the category, upserts by s3_key, links tags, tags S3 active', async () => {
  const token = h.adminToken(['assets.*']);
  const stamp = Date.now();
  const cat = await models.AssetCategory.create({ name: `IMP Asset Cat ${stamp}`, slug: `imp-asset-cat-${stamp}` });
  track.assetCategories.push(cat.id);
  const iconKey  = `assets/icon/imp-${stamp}.svg`;
  const audioKey = `assets/audio/imp-${stamp}.mp3`;
  const tagName  = `impasset-${stamp}`;

  const csv = (name) => [
    'category,name,asset_type,s3_key,is_premium,status,tags',
    // category by slug, and a full console URL that must be trimmed to the key
    `${cat.slug},${name},icon,https://test-bucket.s3.ap-south-1.amazonaws.com/${iconKey},0,active,${tagName}`,
    // category by name; audio key + audio content type -> no warnings
    `${cat.name},IMP Chime ${stamp},audio,${audioKey},1,inactive,`,
  ].join('\n');

  const present = { [iconKey]: { content_type: 'image/svg+xml' }, [audioKey]: { content_type: 'audio/mpeg' } };
  const { result: res, tagged } = await withS3Objects(present, () => importCsv('assets', csv(`IMP Diya ${stamp}`), { token }));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.summary.created, 2);
  assert.equal(res.body.data.summary.skipped, 0);
  assert.deepEqual(res.body.data.rows.flatMap((r) => r.warnings), [], 'clean rows carry no warnings');

  const assets = await models.Asset.findAll({ where: { category_id: cat.id }, include: [models.Tag] });
  assert.equal(assets.length, 2);
  track.assets.push(...assets.map((a) => a.id));
  const icon = assets.find((a) => a.asset_type === 'icon');
  assert.equal(icon.s3_key, iconKey, 'pasted URL normalized to the bare key');
  assert.equal(icon.status, 'active');
  assert.equal(icon.is_premium, 0);
  assert.deepEqual(icon.Tags.map((t) => t.name), [tagName]);
  const audio = assets.find((a) => a.asset_type === 'audio');
  assert.equal(audio.status, 'inactive');
  assert.equal(audio.is_premium, 1);
  track.tags.push(...(await models.Tag.findAll({ where: { name: tagName } })).map((t) => t.id));

  assert.deepEqual(tagged.map(([k]) => k).sort(), [audioKey, iconKey].sort(), 'both files flipped to status=active');

  // Same keys, renamed: the file is the identity, so this renames rather than duplicates.
  const { result: res2 } = await withS3Objects(present, () => importCsv('assets', csv(`IMP Deepam ${stamp}`), { token }));
  assert.equal(res2.body.data.summary.updated, 2);
  assert.equal(res2.body.data.summary.created, 0);
  await icon.reload();
  assert.equal(icon.name, `IMP Deepam ${stamp}`, 'name corrected in place');
  assert.equal(await models.Asset.count({ where: { category_id: cat.id } }), 2, 'no duplicates');
});

test('import assets: skips unknown category, blank s3_key and bad asset_type; warns on key problems', async () => {
  const token = h.adminToken(['assets.*']);
  const stamp = Date.now();
  const cat = await models.AssetCategory.create({ name: `IMP Warn Cat ${stamp}`, slug: `imp-warn-cat-${stamp}` });
  track.assetCategories.push(cat.id);
  const strayKey = `assets/emoji/stray-${stamp}.png`;   // wrong folder for an icon, absent from the bucket
  const dupKey   = `assets/icon/dup-${stamp}.svg`;

  const csv = [
    'category,name,asset_type,s3_key,is_premium,status,tags',
    `No Such Category ${stamp},IMP NoCat ${stamp},icon,assets/icon/x-${stamp}.svg,0,active,`, // unknown category -> skip
    `${cat.slug},IMP NoFile ${stamp},icon,,0,active,`,                                        // no file -> skip
    `${cat.slug},IMP BadType ${stamp},sticker,assets/icon/y-${stamp}.svg,0,active,`,          // bad asset_type -> skip
    `${cat.slug},IMP Stray ${stamp},icon,${strayKey},0,active,`,                              // wrong prefix + missing -> warnings only
    `${cat.slug},IMP Dup A ${stamp},icon,${dupKey},0,active,`,
    `${cat.slug},IMP Dup B ${stamp},icon,${dupKey},0,active,`,                                // same file -> updates the row above
  ].join('\n');

  const { result: res, tagged } = await withS3Objects({ [dupKey]: { content_type: 'image/svg+xml' } }, () => importCsv('assets', csv, { token }));
  assert.equal(res.status, 200);
  const rows = res.body.data.rows;
  const row = (n) => rows.find((r) => r.name === `IMP ${n} ${stamp}`);
  assert.match(row('NoCat').message, /category 'No Such Category .*' not found/);
  assert.match(row('NoCat').message, /import asset-categories/);
  assert.match(row('NoFile').message, /s3_key is required/);
  assert.match(row('BadType').message, /asset_type/);
  assert.equal(res.body.data.summary.skipped, 3);

  assert.equal(row('Stray').status, 'created', 'key problems never skip a row');
  const strayWarnings = row('Stray').warnings.join(' | ');
  assert.match(strayWarnings, /expected a key under 'assets\/icon\/'/);
  assert.match(strayWarnings, /no such object in S3/);
  assert.match(row('Dup B').warnings.join(' | '), /same file as line \d+ — that record is updated, not duplicated/);
  assert.equal(row('Dup A').status, 'created');
  assert.equal(row('Dup B').status, 'updated');
  assert.deepEqual(tagged.map(([k]) => k), [dupKey], 'the absent stray key is not tagged');

  const made = await models.Asset.findAll({ where: { category_id: cat.id } });
  assert.equal(made.length, 2, 'stray + one deduplicated row');
  assert.equal(made.find((a) => a.s3_key === dupKey).name, `IMP Dup B ${stamp}`, 'second row won the key');
  track.assets.push(...made.map((a) => a.id));
});

test('import assets: an audio row pointing at an image warns about the file type', async () => {
  const token = h.adminToken(['assets.*']);
  const stamp = Date.now();
  const cat = await models.AssetCategory.create({ name: `IMP Kind Cat ${stamp}`, slug: `imp-kind-cat-${stamp}` });
  track.assetCategories.push(cat.id);
  const key = `assets/audio/wrong-${stamp}.png`;
  const csv = [
    'category,name,asset_type,s3_key,is_premium,status,tags',
    `${cat.slug},IMP WrongKind ${stamp},audio,${key},0,active,`,
  ].join('\n');

  const { result: res } = await withS3Objects({ [key]: { content_type: 'image/png' } }, () => importCsv('assets', csv, { token }));
  const warnings = res.body.data.rows[0].warnings.join(' | ');
  assert.match(warnings, /'png' is not an audio type/, 'extension checked against the asset_type, not a fixed image list');
  assert.match(warnings, /object is 'image\/png', not an audio/);
  assert.equal(res.body.data.summary.created, 1);
  const made = await models.Asset.findAll({ where: { category_id: cat.id } });
  track.assets.push(...made.map((a) => a.id));
});

test('import assets: enforces the assets permission and validates the header', async () => {
  const forbidden = await importCsv('assets', 'category,name,asset_type,s3_key\nX,Y,icon,assets/icon/z.svg', { token: h.adminToken(['categories.*']) });
  assert.equal(forbidden.status, 403);

  const noCategory = await importCsv('assets', 'name,asset_type,s3_key\nY,icon,assets/icon/z.svg', { token: h.adminToken(['assets.*']) });
  assert.equal(noCategory.status, 400);
  assert.match(noCategory.body.error.message, /category/);
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
  const uId = (await User.create({ uid: uuid(), name: 'TST Ind User', phone: `9${String((Date.now() + 71) % 1000000000).padStart(9, '0')}` })).id;
  track.users.push(uId);
  const created = await h.request('POST', `${P}/businesses`, { token: h.userTokenFor(uId), body: { name: 'TST Ind Biz', industry: 'restaurant-food' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.category_id, 1, 'industry slug resolved to category_id on create');

  // unknown industry -> clean 400. Needs a fresh owner: the account above already
  // holds its one permitted business, which would 409 before the industry is read.
  const uId2 = (await User.create({ uid: uuid(), name: 'TST Ind User2', phone: `9${String((Date.now() + 72) % 1000000000).padStart(9, '0')}` })).id;
  track.users.push(uId2);
  const bad = await h.request('POST', `${P}/businesses`, { token: h.userTokenFor(uId2), body: { name: 'TST Ind Bad', industry: 'no-such-industry' } });
  assert.equal(bad.status, 400);
});

// ---------- Related industries (SEO cross-links) ----------
// Builds a small fixture: `anchor` is the landing page being curated, and it links
// out to two active industries plus one that has been deactivated.
const makeIndustry = async (label, stamp, { is_active = 1 } = {}) => {
  const row = await models.BusinessCategory.create({
    uid: uuid(), parent_id: null, name: `TST ${label} ${stamp}`, slug: `tst-${label.toLowerCase()}-${stamp}`, display_order: 0, is_active,
  });
  track.businessCategories.push(row.id);
  return row;
};

test('admin related industries: ordered full replace, self-link and unknown id rejected', async () => {
  const stamp  = Date.now();
  const token  = h.adminToken(['categories.*']);
  const anchor = await makeIndustry('RelAnchor', stamp);
  const relA   = await makeIndustry('RelA', stamp);
  const relB   = await makeIndustry('RelB', stamp);

  const url = `${P}/admin/business-categories/${anchor.uid}/related`;

  // empty to start
  const before = await h.request('GET', url, { token });
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.data.RelatedIndustries, [], 'no cross-links curated yet');

  // array order becomes display_order
  const set = await h.request('PUT', url, { token, body: { related_industry_ids: [relB.id, relA.id] } });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.data.RelatedIndustries.map((r) => r.uid), [relB.uid, relA.uid], 'curated order round-trips');
  assert.ok(set.body.data.RelatedIndustries.every((r) => r.BusinessCategoryRelated === undefined), 'join payload stripped');

  // re-sending the same ids in a new order is how a drag-and-drop reorder lands
  const reordered = await h.request('PUT', url, { token, body: { related_industry_ids: [relA.id, relB.id] } });
  assert.deepEqual(reordered.body.data.RelatedIndustries.map((r) => r.uid), [relA.uid, relB.uid], 'reorder applied');

  // ONE-WAY: relA did not gain a link back to the anchor
  const reverse = await h.request('GET', `${P}/admin/business-categories/${relA.uid}/related`, { token });
  assert.deepEqual(reverse.body.data.RelatedIndustries, [], 'relation is not reciprocal');

  // guard rails
  const self = await h.request('PUT', url, { token, body: { related_industry_ids: [anchor.id] } });
  assert.equal(self.status, 400, 'an industry cannot be related to itself');
  const unknown = await h.request('PUT', url, { token, body: { related_industry_ids: [relA.id, 999999] } });
  assert.equal(unknown.status, 404, 'unknown id rejects the whole batch');
  const dupes = await h.request('PUT', url, { token, body: { related_industry_ids: [relA.id, relA.id] } });
  assert.equal(dupes.status, 400, 'duplicate ids rejected');

  // the batch that failed changed nothing
  const after = await h.request('GET', url, { token });
  assert.deepEqual(after.body.data.RelatedIndustries.map((r) => r.uid), [relA.uid, relB.uid], 'rejected writes left the block intact');

  // deprecated alias key, and empty array clears the block
  const alias = await h.request('PUT', url, { token, body: { related_category_ids: [relB.id] } });
  assert.deepEqual(alias.body.data.RelatedIndustries.map((r) => r.uid), [relB.uid], 'related_category_ids alias accepted');
  const cleared = await h.request('PUT', url, { token, body: { related_industry_ids: [] } });
  assert.deepEqual(cleared.body.data.RelatedIndustries, [], 'empty array clears the block');

  // permissions: categories.read cannot write
  const forbidden = await h.request('PUT', url, { token: h.adminToken(['categories.read']), body: { related_industry_ids: [relA.id] } });
  assert.equal(forbidden.status, 403);

  await models.BusinessCategoryRelated.destroy({ where: { category_id: anchor.id } });
});

test('catalogue exposes related industries via /industries/{ref} and ?with_related', async () => {
  const stamp  = Date.now() + 1;
  const token  = h.adminToken(['categories.*']);
  const anchor = await makeIndustry('SeoAnchor', stamp);
  const relA   = await makeIndustry('SeoA', stamp);
  const relB   = await makeIndustry('SeoB', stamp);
  const dark   = await makeIndustry('SeoDark', stamp, { is_active: 0 });

  await h.request('PUT', `${P}/admin/business-categories/${anchor.uid}/related`, {
    token, body: { related_industry_ids: [relB.id, dark.id, relA.id] },
  });

  // detail endpoint — public, resolves by slug, always carries the block
  const bySlug = await h.request('GET', `${P}/industries/${anchor.slug}`);
  assert.equal(bySlug.status, 200);
  assert.equal(bySlug.body.data.uid, anchor.uid);
  assert.deepEqual(bySlug.body.data.RelatedIndustries.map((r) => r.uid), [relB.uid, relA.uid], 'curated order kept, inactive link dropped');

  // uid and legacy numeric id resolve to the same industry
  for (const ref of [anchor.uid, anchor.id]) {
    const r = await h.request('GET', `${P}/industries/${ref}`);
    assert.equal(r.body.data.uid, anchor.uid, `resolved by ${ref === anchor.id ? 'id' : 'uid'}`);
  }

  assert.equal((await h.request('GET', `${P}/industries/no-such-industry`)).status, 404);
  assert.equal((await h.request('GET', `${P}/industries/${dark.slug}`)).status, 404, 'inactive industry is not addressable');

  // list endpoint — opt-in, and absent by default
  const plain = await h.request('GET', `${P}/industries`);
  assert.ok(plain.body.data.every((c) => c.RelatedIndustries === undefined), 'lean by default');

  const withRelated = await h.request('GET', `${P}/industries?with_related=1`);
  assert.equal(withRelated.status, 200);
  const row = withRelated.body.data.find((c) => c.uid === anchor.uid);
  assert.deepEqual(row.RelatedIndustries.map((r) => r.uid), [relB.uid, relA.uid], 'block attached to the list row');
  assert.ok(withRelated.body.data.some((c) => c.uid === relA.uid && c.RelatedIndustries.length === 0), 'industries with no links still returned');

  // combines with the shape switches
  const tree = await h.request('GET', `${P}/industries?tree=1&with_related=1`);
  const treeNode = tree.body.data.find((c) => c.uid === anchor.uid);
  assert.deepEqual(treeNode.RelatedIndustries.map((r) => r.uid), [relB.uid, relA.uid], 'tree nodes carry the block');
  assert.ok(Array.isArray(treeNode.children), 'tree shape preserved');

  const top = await h.request('GET', `${P}/industries?hierarchy=1&with_related=1`);
  assert.ok(top.body.data.find((c) => c.uid === anchor.uid).RelatedIndustries.length === 2, 'hierarchy rows carry the block');

  // the deprecated list alias honours it too
  const alias = await h.request('GET', `${P}/business-categories?with_related=1`);
  assert.ok(alias.body.data.find((c) => c.uid === anchor.uid).RelatedIndustries.length === 2, 'alias honours with_related');

  await models.BusinessCategoryRelated.destroy({ where: { category_id: anchor.id } });
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
  const a = await User.create({ uid: uuid(), name: 'TST A', phone: `7${String(Date.now() % 1000000000).padStart(9, '0')}` });
  const b = await User.create({ uid: uuid(), name: 'TST B', phone: `6${String((Date.now() + 3) % 1000000000).padStart(9, '0')}` });
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
  const u = await User.create({ uid: uuid(), name: 'TST Pay', phone: `5${String(Date.now() % 1000000000).padStart(9, '0')}` });
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
  const u = await User.create({ uid: uuid(), name: `TST ${prefix}`, phone: `6${String(Date.now() % 1000000000).padStart(9, '0')}${couponSeq++}`.slice(0, 10) });
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

// ---------- Signup: industry + sub-industry + keywords ----------
// Fixture: a parent industry with one child sub-industry, keywords curated on both
// (two on the child, one on the parent only) so inheritance is observable.
const mkKeywordFixture = async (stamp) => {
  const parent = await models.BusinessCategory.create({
    uid: uuid(), parent_id: null, name: `TST KwParent ${stamp}`, slug: `tst-kwparent-${stamp}`, is_active: 1,
  });
  track.businessCategories.push(parent.id);
  const child = await models.BusinessCategory.create({
    uid: uuid(), parent_id: parent.id, name: `TST KwChild ${stamp}`, slug: `tst-kwchild-${stamp}`, is_active: 1,
  });
  track.businessCategories.push(child.id);

  const tags = [];
  for (const label of ['Cakes', 'Brownies', 'Generic']) {
    const t = await models.Tag.create({ name: `TST ${label} ${stamp}`, slug: `tst-${label.toLowerCase()}-${stamp}` });
    track.tags.push(t.id);
    tags.push(t);
  }
  await child.setTags([tags[0].id, tags[1].id]);
  await parent.setTags([tags[2].id]);
  return { parent, child, tags };
};

test('industry keywords: a sub-industry inherits its parent keywords, own ones first', async () => {
  const stamp = Date.now();
  const { parent, child, tags } = await mkKeywordFixture(stamp);

  const r = await h.request('GET', `${P}/industries/${child.slug}/keywords`);
  assert.equal(r.status, 200);
  const names = r.body.data.map((t) => t.name);
  assert.equal(names.length, 3, 'own 2 + inherited 1');
  assert.ok(names.slice(0, 2).includes(tags[0].name) && names.slice(0, 2).includes(tags[1].name), 'own keywords lead');
  assert.equal(names[2], tags[2].name, 'the parent-only keyword trails');

  // A top-level industry has nothing to inherit.
  const top = await h.request('GET', `${P}/industries/${parent.slug}/keywords`);
  assert.deepEqual(top.body.data.map((t) => t.name), [tags[2].name]);

  assert.equal((await h.request('GET', `${P}/industries/no-such-industry/keywords`)).status, 404);
});

test('create business with sub_industry + keywords (id / slug / name all resolve)', async () => {
  const stamp = Date.now() + 1;
  const { parent, child, tags } = await mkKeywordFixture(stamp);
  const u     = await mkUser('KwOwner');
  const token = h.userTokenFor(u.id);

  const created = await h.request('POST', `${P}/businesses`, {
    token,
    body: {
      name: `TST Kw Biz ${stamp}`,
      industry: parent.slug,
      sub_industry: child.slug,
      keywords: [tags[0].id, tags[1].slug, tags[2].name],   // all three ref forms
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.category_id, child.id, 'sub_industry wins over the parent industry');
  assert.deepEqual(created.body.data.Tags.map((t) => t.id).sort(), tags.map((t) => t.id).sort());

  // One business per user.
  const second = await h.request('POST', `${P}/businesses`, { token, body: { name: `TST Kw Biz2 ${stamp}`, industry: parent.slug } });
  assert.equal(second.status, 409, 'a second business is refused');

  // An unrecognised keyword is named in the 400, never silently dropped.
  const other = await mkUser('KwOwner2');
  const bad = await h.request('POST', `${P}/businesses`, {
    token: h.userTokenFor(other.id),
    body:  { name: `TST Kw Bad ${stamp}`, industry: parent.slug, keywords: [tags[0].slug, 'no-such-keyword'] },
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.details.some((d) => d.message.includes('no-such-keyword')));
  assert.equal(await Business.count({ where: { user_id: other.id } }), 0, 'the whole create rolled back');

  // A sub-industry from a different parent is rejected.
  const mismatch = await h.request('POST', `${P}/businesses`, {
    token: h.userTokenFor(other.id),
    body:  { name: `TST Kw Mismatch ${stamp}`, industry: 'restaurant-food', sub_industry: child.slug },
  });
  assert.equal(mismatch.status, 400);

  // sub_industry and custom_sub_industry are mutually exclusive.
  const both = await h.request('POST', `${P}/businesses`, {
    token: h.userTokenFor(other.id),
    body:  { name: `TST Kw Both ${stamp}`, industry: parent.slug, sub_industry: child.slug, custom_sub_industry: 'Whatever' },
  });
  assert.equal(both.status, 400);
});

test('PUT /businesses/{uid}/keywords replaces the set and is owner-only', async () => {
  const stamp = Date.now() + 2;
  const { parent, tags } = await mkKeywordFixture(stamp);
  const owner = await mkUser('KwMgr');
  const token = h.userTokenFor(owner.id);

  const biz = (await h.request('POST', `${P}/businesses`, {
    token, body: { name: `TST Kw Mgr ${stamp}`, industry: parent.slug, keywords: [tags[0].id, tags[1].id] },
  })).body.data;

  const replaced = await h.request('PUT', `${P}/businesses/${biz.uid}/keywords`, { token, body: { keywords: [tags[2].id] } });
  assert.equal(replaced.status, 200);
  assert.deepEqual(replaced.body.data.map((t) => t.id), [tags[2].id], 'full replace, not a merge');

  const cleared = await h.request('PUT', `${P}/businesses/${biz.uid}/keywords`, { token, body: { keywords: [] } });
  assert.deepEqual(cleared.body.data, [], 'an empty array clears the set');

  const stranger = await mkUser('KwStranger');
  const denied = await h.request('PUT', `${P}/businesses/${biz.uid}/keywords`, {
    token: h.userTokenFor(stranger.id), body: { keywords: [tags[0].id] },
  });
  assert.equal(denied.status, 403);
});

test('custom sub-industry: files a pending suggestion, hidden publicly until an admin approves', async () => {
  const stamp    = Date.now() + 3;
  const { parent } = await mkKeywordFixture(stamp);
  const owner    = await mkUser('SugOwner');
  const token    = h.userTokenFor(owner.id);
  const customName = `TST Cloud Kitchen ${stamp}`;

  const created = await h.request('POST', `${P}/businesses`, {
    token,
    body: { name: `TST Sug Biz ${stamp}`, industry: parent.slug, custom_sub_industry: customName, latitude: 12.9, longitude: 77.6 },
  });
  assert.equal(created.status, 201);

  const suggested = await models.BusinessCategory.findOne({ where: { name: customName } });
  track.businessCategories.push(suggested.id);
  assert.equal(suggested.status, 'pending');
  assert.equal(suggested.is_active, 0);
  assert.equal(suggested.parent_id, parent.id, 'parented to the industry the owner did find');
  assert.equal(suggested.suggested_by_user_id, owner.id);
  assert.equal(created.body.data.category_id, suggested.id, 'the business links to it right away');

  // Invisible in the public catalogue...
  const cat = await h.request('GET', `${P}/industries`);
  assert.ok(!cat.body.data.some((c) => c.name === customName), 'a pending suggestion is not offered');
  assert.equal((await h.request('GET', `${P}/industries/${suggested.slug}`)).status, 404);

  // ...and the storefront shows no industry chip while it waits.
  const pub = await h.request('GET', `${P}/businesses/${created.body.data.uid}/public`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.data.category, undefined, 'no chip for an unapproved industry');
  assert.equal(pub.body.data.category_id, null, 'and the id does not leak either');

  // The owner still sees it, with its moderation state.
  const mine = await h.request('GET', `${P}/businesses/${created.body.data.uid}`, { token });
  assert.equal(mine.body.data.BusinessCategory.status, 'pending', 'the owner can render "pending approval"');

  // A second owner suggesting the same name joins the queue instead of duplicating it.
  const other = await mkUser('SugOwner2');
  const again = await h.request('POST', `${P}/businesses`, {
    token: h.userTokenFor(other.id),
    body:  { name: `TST Sug Biz2 ${stamp}`, industry: parent.slug, custom_sub_industry: customName.toLowerCase() },
  });
  assert.equal(again.status, 201);
  assert.equal(again.body.data.category_id, suggested.id, 'converges on the existing suggestion (case-insensitive)');
  assert.equal(await models.BusinessCategory.count({ where: { parent_id: parent.id, status: 'pending' } }), 1);

  // Admin moderation queue, then approval.
  const adminTok = h.adminToken(['categories.*']);
  const queue = await h.request('GET', `${P}/admin/business-categories?status=pending`, { token: adminTok });
  assert.equal(queue.status, 200);
  const queued = queue.body.data.find((c) => c.uid === suggested.uid);
  assert.ok(queued, 'the suggestion is in the queue');
  assert.equal(queued.suggestedBy.id, owner.id, 'the admin can see who asked for it');

  const approved = await h.request('PATCH', `${P}/admin/business-categories/${suggested.uid}`, {
    token: adminTok, body: { status: 'approved' },
  });
  assert.equal(approved.status, 200);
  await suggested.reload();
  assert.equal(suggested.is_active, 1, 'approving publishes it');

  // It now behaves as an ordinary industry, with no write to the businesses.
  const after = await h.request('GET', `${P}/businesses/${created.body.data.uid}/public`);
  assert.equal(after.body.data.category.name, customName, 'the chip appears on approval');
  assert.ok((await h.request('GET', `${P}/industries`)).body.data.some((c) => c.name === customName));
});

test('custom sub-industry requires an industry, and a rejected name is refused', async () => {
  const stamp = Date.now() + 4;
  const u1 = await mkUser('SugNoParent');

  const orphan = await h.request('POST', `${P}/businesses`, {
    token: h.userTokenFor(u1.id), body: { name: `TST Sug Orphan ${stamp}`, custom_sub_industry: `TST Orphan ${stamp}` },
  });
  assert.equal(orphan.status, 400, 'a suggestion needs a parent industry for the admin to review it');

  const rejectedName = `TST Rejected ${stamp}`;
  const rejected = await models.BusinessCategory.create({
    uid: uuid(), parent_id: 1, name: rejectedName, slug: `tst-rejected-${stamp}`, status: 'rejected', is_active: 0,
  });
  track.businessCategories.push(rejected.id);

  const u2 = await mkUser('SugRejected');
  const retry = await h.request('POST', `${P}/businesses`, {
    token: h.userTokenFor(u2.id), body: { name: `TST Sug Retry ${stamp}`, industry: 'restaurant-food', custom_sub_industry: rejectedName },
  });
  assert.equal(retry.status, 400, 'a previously rejected industry cannot be re-suggested');
});

// ---------- Signup step 2: BUSINESS vs PERSONAL ----------
test('PATCH /users/me is an allow-list: server-owned columns are not writable', async () => {
  const u     = await mkUser('MassAssign');
  const token = h.userTokenFor(u.id);

  for (const body of [
    { password_hash: 'pwned' },
    { is_active: 0 },
    { razorpay_customer_id: 'cust_evil' },
    { phone: '9000000001' },
    { uid: uuid() },
  ]) {
    const r = await h.request('PATCH', `${P}/users/me`, { token, body });
    assert.equal(r.status, 400, `${Object.keys(body)[0]} must be rejected`);
  }

  await u.reload();
  assert.equal(u.is_active, 1, 'nothing slipped through');
  assert.equal(u.password_hash, null);

  const ok = await h.request('PATCH', `${P}/users/me`, { token, body: { name: 'TST Renamed' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.name, 'TST Renamed');
  assert.equal(ok.body.data.password_hash, undefined, 'the hash never goes back to the client');
  assert.equal((await h.request('GET', `${P}/users/me`, { token })).body.data.password_hash, undefined);
});

test('personal account: choosing it completes onboarding and blocks business creation', async () => {
  const u     = await mkUser('Personal');
  const token = h.userTokenFor(u.id);

  const before = await h.request('GET', `${P}/users/me`, { token });
  assert.deepEqual(before.body.data.onboarding, { account_type: null, has_business: false, completed: false });

  const chosen = await h.request('PATCH', `${P}/users/me`, { token, body: { account_type: 'personal' } });
  assert.equal(chosen.status, 200);
  assert.deepEqual(chosen.body.data.onboarding, { account_type: 'personal', has_business: false, completed: true },
    'a personal account has nothing left to answer');

  // No business row, and no way to make one.
  const biz = await h.request('POST', `${P}/businesses`, { token, body: { name: 'TST Personal Biz', industry: 'restaurant-food' } });
  assert.equal(biz.status, 409);
  assert.equal(await Business.count({ where: { user_id: u.id } }), 0);

  // The answer is frozen once onboarding is stamped.
  const flip = await h.request('PATCH', `${P}/users/me`, { token, body: { account_type: 'business' } });
  assert.equal(flip.status, 409, 'account type cannot be changed after signup');

  // Re-sending the same value is a harmless no-op, not a 409.
  assert.equal((await h.request('PATCH', `${P}/users/me`, { token, body: { account_type: 'personal' } })).status, 200);
});

test('business account: onboarding completes on business creation, then freezes', async () => {
  const u     = await mkUser('BizFlow');
  const token = h.userTokenFor(u.id);

  // Step 2 picks BUSINESS but the flow is not finished â€” industry and business
  // details still to come, so the app must resume here on next login.
  await h.request('PATCH', `${P}/users/me`, { token, body: { account_type: 'business' } });
  const mid = await h.request('GET', `${P}/users/me`, { token });
  assert.deepEqual(mid.body.data.onboarding, { account_type: 'business', has_business: false, completed: false });

  // Mid-flow the user may still switch (the "SWITCH TO PERSONAL" button), and back.
  assert.equal((await h.request('PATCH', `${P}/users/me`, { token, body: { account_type: 'personal' } })).status, 200);
  const back = await h.request('PATCH', `${P}/users/me`, { token, body: { account_type: 'business' } });
  assert.equal(back.status, 409, 'switching to personal completed onboarding, which freezes the answer');
});

test('business creation completes onboarding for an account that never answered step 2', async () => {
  const u     = await mkUser('BizDirect');
  const token = h.userTokenFor(u.id);

  const created = await h.request('POST', `${P}/businesses`, {
    token, body: { name: `TST Direct Biz ${Date.now()}`, industry: 'restaurant-food' },
  });
  assert.equal(created.status, 201);

  await u.reload();
  assert.equal(u.account_type, 'business', 'creating a business IS the business path');
  assert.ok(u.onboarding_completed_at, 'and it is the last step, so the flow is finished');

  const me = await h.request('GET', `${P}/users/me`, { token });
  assert.deepEqual(me.body.data.onboarding, { account_type: 'business', has_business: true, completed: true });
});

test('a failed business create leaves onboarding unfinished', async () => {
  const u     = await mkUser('BizRollback');
  const token = h.userTokenFor(u.id);

  const bad = await h.request('POST', `${P}/businesses`, {
    token, body: { name: 'TST Rollback Biz', industry: 'restaurant-food', keywords: ['no-such-keyword'] },
  });
  assert.equal(bad.status, 400);

  await u.reload();
  assert.equal(u.onboarding_completed_at, null, 'the stamp rolled back with the business');
  assert.equal(u.account_type, null);
});

test('changePassword tells an OTP-only account it has no password, rather than throwing', async () => {
  const u = await mkUser('NoPassword');
  const r = await h.request('PATCH', `${P}/users/me/password`, {
    token: h.userTokenFor(u.id), body: { current_password: 'whatever', new_password: 'newpassword1' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /OTP/);
});

test('GET /industries?q= searches by name, and narrows within a parent', async () => {
  const stamp = Date.now() + 5;
  const { parent, child } = await mkKeywordFixture(stamp);

  const hit = await h.request('GET', `${P}/industries?q=${encodeURIComponent(`KwChild ${stamp}`)}`);
  assert.equal(hit.status, 200);
  assert.deepEqual(hit.body.data.map((c) => c.id), [child.id]);

  // Combined with `parent`, this is the specialization search.
  const scoped = await h.request('GET', `${P}/industries?parent=${parent.slug}&q=KwChild`);
  assert.ok(scoped.body.data.every((c) => c.parent_id === parent.id));
  assert.ok(scoped.body.data.some((c) => c.id === child.id));

  const miss = await h.request('GET', `${P}/industries?q=zzz-no-such-industry-zzz`);
  assert.deepEqual(miss.body.data, []);
});

// ---------- User uploads (presign -> PUT -> confirm, then save the key) ----------
// S3 is stubbed: presigning needs credentials and confirm does a HEAD, neither of
// which exists in the test env. The stub records what would have been called.
const withStubbedS3 = async (fn, { size = 1024, exists = true } = {}) => {
  const s3 = require('../src/utils/s3Helper');
  const original = {
    getPresignedPutUrl: s3.getPresignedPutUrl,
    objectExists:       s3.objectExists,
    putObjectTagging:   s3.putObjectTagging,
    deleteFile:         s3.deleteFile,
  };
  const calls = { tagged: [], deleted: [] };
  s3.getPresignedPutUrl = async (key) => `https://s3.test/${key}?signed=1`;
  s3.objectExists       = async () => (exists ? { exists: true, content_type: 'image/png', size } : { exists: false });
  s3.putObjectTagging   = async (key, status) => { calls.tagged.push([key, status]); };
  s3.deleteFile         = async (key) => { calls.deleted.push(key); };
  try { return await fn(calls); } finally { Object.assign(s3, original); }
};

test('presign issues a key under the callers own namespace and rejects bad slots/types', async () => {
  const u     = await mkUser('Upload');
  const token = h.userTokenFor(u.id);

  await withStubbedS3(async () => {
    const r = await h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot: 'business_logo' }, filename: 'my logo.PNG', content_type: 'image/png' },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.key.startsWith(`users/${u.uid}/logo/`), 'namespaced to the caller');
    assert.ok(r.body.data.key.endsWith('.png'), 'extension preserved, name dropped');
    assert.equal(r.body.data.required_headers['x-amz-tagging'], 'status=pending');
    assert.ok(r.body.data.upload_url);

    // The client cannot choose a prefix â€” only a known slot.
    assert.equal((await h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot: 'templates' }, filename: 'x.png' },
    })).status, 400);

    // Non-image uploads are refused outright.
    assert.equal((await h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot: 'business_logo' }, filename: 'x.svg', content_type: 'image/svg+xml' },
    })).status, 400);
  });
});

test('confirm promotes only your own keys, and deletes anything over the size limit', async () => {
  const mine     = await mkUser('ConfirmMine');
  const stranger = await mkUser('ConfirmOther');
  const token    = h.userTokenFor(mine.id);

  await withStubbedS3(async (calls) => {
    const key = (await h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot: 'profile_photo' }, filename: 'me.jpg' },
    })).body.data.key;

    const ok = await h.request('POST', `${P}/uploads/confirm`, { token, body: { keys: [key] } });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls.tagged, [[key, 'active']]);

    // Another user's key, and an admin asset key, are both outside the namespace.
    for (const foreign of [`users/${stranger.uid}/profile/abc.jpg`, 'assets/icon/premium.png']) {
      const r = await h.request('POST', `${P}/uploads/confirm`, { token, body: { keys: [foreign] } });
      assert.equal(r.status, 400, `${foreign} must be refused`);
    }
    assert.equal(calls.tagged.length, 1, 'nothing foreign was promoted');
  });

  // Oversized objects are deleted instead of promoted, so the key can never be saved.
  await withStubbedS3(async (calls) => {
    const key = (await h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot: 'profile_photo' }, filename: 'huge.jpg' },
    })).body.data.key;
    const r = await h.request('POST', `${P}/uploads/confirm`, { token, body: { keys: [key] } });
    assert.equal(r.status, 400);
    assert.deepEqual(calls.deleted, [key]);
    assert.deepEqual(calls.tagged, []);
  }, { size: 11 * 1024 * 1024 });
});

test('batch presign issues one key per file and validates the whole batch before signing any', async () => {
  const u     = await mkUser('BulkPresign');
  const token = h.userTokenFor(u.id);

  await withStubbedS3(async () => {
    const r = await h.request('POST', `${P}/uploads/presign`, {
      token,
      body: { files: [
        { target: { slot: 'media_library' }, filename: 'a.png', content_type: 'image/png' },
        { target: { slot: 'media_library' }, filename: 'b.jpg' },
        { target: { slot: 'product_image' }, filename: 'c.webp' },   // slots may be mixed
      ] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.files.length, 3);

    const [a, b, c] = r.body.data.files;
    assert.ok(a.key.startsWith(`users/${u.uid}/media/`) && a.key.endsWith('.png'));
    assert.ok(b.key.startsWith(`users/${u.uid}/media/`) && b.key.endsWith('.jpg'));
    assert.ok(c.key.startsWith(`users/${u.uid}/products/`), 'per-file slot, not one for the batch');
    assert.equal(new Set(r.body.data.files.map((f) => f.key)).size, 3, 'keys are distinct');
    assert.ok(r.body.data.files.every((f) => f.upload_url && f.required_headers['x-amz-tagging'] === 'status=pending'));

    // Per-account limits are reported once, not per file.
    assert.equal(r.body.data.max_bytes, 10 * 1024 * 1024);
    assert.ok('storage_remaining' in r.body.data);
    assert.ok(!('key' in r.body.data), 'batch response does not also carry the single-file shape');

    // The single-file shape is untouched, and the two cannot be combined.
    const single = await h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot: 'media_library' }, filename: 'solo.png' },
    });
    assert.equal(single.status, 200);
    assert.ok(single.body.data.key && !single.body.data.files, 'flat shape preserved');
    assert.equal((await h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot: 'media_library' }, filename: 'x.png', files: [] },
    })).status, 400, 'one shape or the other, never both');

    // One bad file fails the batch outright — nothing is uploaded yet, so there is
    // nothing to unwind, and the error names which entry was wrong.
    const bad = await h.request('POST', `${P}/uploads/presign`, {
      token,
      body: { files: [
        { target: { slot: 'media_library' }, filename: 'ok.png' },
        { target: { slot: 'media_library' }, filename: 'nope.svg', content_type: 'image/svg+xml' },
      ] },
    });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error.details.some((d) => d.field.startsWith('files.1')), 'error points at the offending entry');

    // Same for the per-slot rules the service enforces (a font slot needs a font
    // extension) — and it reports the index the same way the schema does.
    const wrongExt = await h.request('POST', `${P}/uploads/presign`, {
      token,
      body: { files: [
        { target: { slot: 'media_library' }, filename: 'ok.png' },
        { target: { slot: 'brand_font' },    filename: 'notafont.png' },
      ] },
    });
    assert.equal(wrongExt.status, 400);
    assert.equal(wrongExt.body.error.details[0].field, 'files.1.filename');

    // The cap matches confirm's, so a presigned set can always be confirmed together.
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ target: { slot: 'media_library' }, filename: `f${i}.png` }));
    assert.equal((await h.request('POST', `${P}/uploads/presign`, { token, body: { files: tooMany } })).status, 400);
  });
});

test('confirm reports each key separately and keeps the good files in a partly bad batch', async () => {
  const mine     = await mkUser('BulkConfirm');
  const stranger = await mkUser('BulkConfirmOther');
  const token    = h.userTokenFor(mine.id);

  await withStubbedS3(async (calls) => {
    const keys = (await h.request('POST', `${P}/uploads/presign`, {
      token,
      body: { files: [
        { target: { slot: 'media_library' }, filename: 'good1.png' },
        { target: { slot: 'media_library' }, filename: 'good2.png' },
      ] },
    })).body.data.files.map((f) => f.key);

    const foreign = `users/${stranger.uid}/media/stolen.png`;
    const r = await h.request('POST', `${P}/uploads/confirm`, {
      token, body: { keys: [keys[0], foreign, keys[1]] },
    });

    // One bad key no longer discards the two good uploads.
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.results.map((x) => x.status), ['confirmed', 'rejected', 'confirmed']);
    assert.equal(r.body.data.results[1].code, 'VALIDATION_ERROR');
    assert.ok(r.body.data.results[1].reason);
    assert.deepEqual(r.body.data.keys, [keys[0], keys[1]], 'keys lists the confirmed ones only');
    assert.deepEqual(calls.tagged, [[keys[0], 'active'], [keys[1], 'active']], 'the foreign key was never promoted');

    // Re-confirming is idempotent, not a double charge, and still reads as confirmed.
    const again = await h.request('POST', `${P}/uploads/confirm`, { token, body: { keys } });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.data.results.map((x) => x.status), ['confirmed', 'confirmed']);
    assert.equal(calls.tagged.length, 2, 'nothing was re-tagged');

    // Every key bad = the request itself fails, as it always did for a single key.
    const allBad = await h.request('POST', `${P}/uploads/confirm`, { token, body: { keys: [foreign] } });
    assert.equal(allBad.status, 400);
    assert.ok(!allBad.body.success);
  });
});

test('a user cannot save an s3_key that was not issued to them (logo, product image, frame, photo)', async () => {
  const owner    = await mkUser('KeyOwner');
  const stranger = await mkUser('KeyThief');
  const token    = h.userTokenFor(owner.id);
  const thiefTok = h.userTokenFor(stranger.id);

  const biz = (await h.request('POST', `${P}/businesses`, {
    token, body: { name: `TST Key Biz ${Date.now()}`, industry: 'restaurant-food' },
  })).body.data;

  const foreign = `users/${stranger.uid}/logo/stolen.png`;
  const admin   = 'assets/icon/premium.png';

  // Business logo / cover.
  for (const body of [{ logo_s3_key: foreign }, { logo_s3_key: admin }, { cover_s3_key: foreign }]) {
    const r = await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token, body });
    assert.equal(r.status, 400, `${JSON.stringify(body)} must be refused`);
  }

  // Wrong slot: a real key of the owner's, but issued for a different purpose.
  const wrongSlot = `users/${owner.uid}/products/x.png`;
  assert.equal((await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token, body: { logo_s3_key: wrongSlot } })).status, 400,
    'a product-image key cannot be saved as a logo');

  // Product image.
  const product = (await h.request('POST', `${P}/products`, {
    token, body: { business_uid: biz.uid, name: 'TST Key Product' },
  })).body.data;
  assert.equal((await h.request('POST', `${P}/products/${product.uid}/images`, {
    token, body: { s3_key: `users/${stranger.uid}/products/stolen.png` },
  })).status, 400);

  // Frame.
  assert.equal((await h.request('POST', `${P}/frames`, {
    token, body: { name: 'TST Key Frame', s3_key: `users/${stranger.uid}/frames/stolen.png` },
  })).status, 400);

  // Profile photo.
  assert.equal((await h.request('PATCH', `${P}/users/me`, {
    token: thiefTok, body: { profile_photo_s3_key: `users/${owner.uid}/profile/stolen.jpg` },
  })).status, 400);
});

test('own keys save normally across every slot, and null clears', async () => {
  const owner = await mkUser('KeyHappy');
  const token = h.userTokenFor(owner.id);

  const logo = `users/${owner.uid}/logo/${uuid()}.png`;
  const biz  = (await h.request('POST', `${P}/businesses`, {
    token, body: { name: `TST Logo Biz ${Date.now()}`, industry: 'restaurant-food', logo_s3_key: logo },
  })).body.data;
  assert.equal(biz.logo_s3_key, logo, 'the logo can now be set at signup, in the same call');

  const cover = `users/${owner.uid}/cover/${uuid()}.png`;
  const patched = await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token, body: { cover_s3_key: cover } });
  assert.equal(patched.body.data.cover_s3_key, cover);

  const cleared = await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token, body: { logo_s3_key: null } });
  assert.equal(cleared.body.data.logo_s3_key, null, 'null clears the image');

  const photo = `users/${owner.uid}/profile/${uuid()}.jpg`;
  assert.equal((await h.request('PATCH', `${P}/users/me`, { token, body: { profile_photo_s3_key: photo } }))
    .body.data.profile_photo_s3_key, photo);

  const frame = await h.request('POST', `${P}/frames`, {
    token, body: { name: 'TST Own Frame', s3_key: `users/${owner.uid}/frames/${uuid()}.png` },
  });
  assert.equal(frame.status, 201);

  const product = (await h.request('POST', `${P}/products`, {
    token, body: { business_uid: biz.uid, name: 'TST Own Product' },
  })).body.data;
  const img = await h.request('POST', `${P}/products/${product.uid}/images`, {
    token, body: { s3_key: `users/${owner.uid}/products/${uuid()}.png` },
  });
  assert.equal(img.status, 201);
});

test('uploads require authentication', async () => {
  assert.equal((await h.request('POST', `${P}/uploads/presign`, { body: { target: { slot: 'business_logo' }, filename: 'x.png' } })).status, 401);
  assert.equal((await h.request('POST', `${P}/uploads/confirm`, { body: { keys: ['users/x/logo/y.png'] } })).status, 401);
});

// ---------- Storage quota ----------
const MB = 1024 * 1024;

const storageUsed = async (userId) => {
  const row = await models.UserQuotaUsage.findOne({ where: { user_id: userId } });
  return row ? Number(row.storage_used_bytes) : 0;
};

// Temporarily narrow the Free plan's storage allowance (feature_type 5) so the
// limit can be crossed with a file under the 10 MB per-upload cap.
const withStorageLimitMb = async (mb, fn) => {
  const pf = await models.PlanFeature.findOne({ where: { plan_id: 1, feature_type_id: 5 } });
  const original = pf.value;
  await pf.update({ value: mb });
  try { return await fn(); } finally { await pf.update({ value: original }); }
};

// Presign + confirm one file of `size` bytes, returning its key.
const uploadOf = async (token, slot, size) => withStubbedS3(async () => {
  const key = (await h.request('POST', `${P}/uploads/presign`, {
    token, body: { target: { slot }, filename: 'f.png' },
  })).body.data.key;
  const r = await h.request('POST', `${P}/uploads/confirm`, { token, body: { keys: [key] } });
  return { key, status: r.status, body: r.body };
}, { size });

test('storage is charged to storage_used_bytes on confirm, once per key', async () => {
  const userId = await userWithActivePlan(1, 9101);          // Free: 100 MB
  const token  = h.userTokenFor(userId);

  assert.equal(await storageUsed(userId), 0);

  const { key, status } = await uploadOf(token, 'user_frame', 2 * MB);
  assert.equal(status, 200);
  assert.equal(await storageUsed(userId), 2 * MB, 'charged to the bytes column, not a phantom storage_count');

  const ledger = await models.UserUpload.findOne({ where: { s3_key: key } });
  assert.equal(Number(ledger.bytes), 2 * MB);
  assert.equal(ledger.slot, 'user_frame');

  // Re-confirming the same key (a client retry) must not charge twice.
  await withStubbedS3(async () => {
    const again = await h.request('POST', `${P}/uploads/confirm`, { token, body: { keys: [key] } });
    assert.equal(again.status, 200);
  }, { size: 2 * MB });
  assert.equal(await storageUsed(userId), 2 * MB, 'idempotent');
});

test('GET /uploads/quota reports the allowance in bytes, and tracks what presign says', async () => {
  const userId = await userWithActivePlan(1, 9110);          // Free: 100 MB
  const token  = h.userTokenFor(userId);

  const before = (await h.request('GET', `${P}/uploads/quota`, { token })).body.data;
  assert.equal(before.limit_bytes, 100 * MB, 'bytes, not the MB the plan stores');
  assert.equal(before.used_bytes, 0);
  assert.equal(before.remaining_bytes, 100 * MB);
  assert.equal(before.unlimited, false);
  assert.equal(before.max_upload_bytes, 10 * MB, 'per-file cap, separate from the allowance');

  await uploadOf(token, 'media_library', 2 * MB);

  const after = (await h.request('GET', `${P}/uploads/quota`, { token })).body.data;
  assert.equal(after.used_bytes, 2 * MB);
  assert.equal(after.remaining_bytes, 98 * MB);

  // The two paths must not drift: this is the same number presign hands back.
  await withStubbedS3(async () => {
    const p = await h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot: 'media_library' }, filename: 'x.png' },
    });
    assert.equal(p.body.data.storage_remaining, after.remaining_bytes);
    assert.equal(p.body.data.max_bytes, after.max_upload_bytes);
  });

  assert.equal((await h.request('GET', `${P}/uploads/quota`)).status, 401);
});

test('an unenforced account reports its usage with no limit', async () => {
  const u     = await mkUser('QuotaFree');          // no subscription at all
  const token = h.userTokenFor(u.id);

  const q = (await h.request('GET', `${P}/uploads/quota`, { token })).body.data;
  assert.equal(q.unlimited, true);
  assert.equal(q.limit_bytes, null);
  assert.equal(q.remaining_bytes, null);
  assert.equal(q.used_bytes, 0, 'recorded even where it is not enforced');
  assert.equal(q.max_upload_bytes, 10 * MB, 'the per-file cap still applies');

  // Usage is still counted, so switching enforcement on later needs no backfill.
  await uploadOf(token, 'media_library', 1 * MB);
  const after = (await h.request('GET', `${P}/uploads/quota`, { token })).body.data;
  assert.equal(after.used_bytes, 1 * MB);
  assert.equal(after.remaining_bytes, null, 'still no ceiling to count down from');
});

test('deleting the file that used the storage gives the bytes back', async () => {
  const userId = await userWithActivePlan(1, 9102);
  const token  = h.userTokenFor(userId);

  const { key } = await uploadOf(token, 'user_frame', 3 * MB);
  assert.equal(await storageUsed(userId), 3 * MB);

  const frame = await h.request('POST', `${P}/frames`, { token, body: { name: 'TST Quota Frame', s3_key: key } });
  assert.equal(frame.status, 201);

  await withStubbedS3(async (calls) => {
    const del = await h.request('DELETE', `${P}/frames/${frame.body.data.uid}`, { token });
    assert.equal(del.status, 200);
    assert.deepEqual(calls.deleted, [key], 'the object is removed, not just the row');
  });

  assert.equal(await storageUsed(userId), 0, 'refunded');
  assert.equal(await models.UserUpload.count({ where: { s3_key: key } }), 0, 'ledger row cleared');
});

test('replacing a business logo releases the old file', async () => {
  const userId = await userWithActivePlan(1, 9103);
  const token  = h.userTokenFor(userId);

  const first = await uploadOf(token, 'business_logo', 1 * MB);
  const biz = (await h.request('POST', `${P}/businesses`, {
    token, body: { name: `TST Quota Biz ${Date.now()}`, industry: 'restaurant-food', logo_s3_key: first.key },
  })).body.data;
  assert.equal(await storageUsed(userId), 1 * MB);

  const second = await uploadOf(token, 'business_logo', 2 * MB);
  assert.equal(await storageUsed(userId), 3 * MB, 'both files are on the books while both exist');

  await withStubbedS3(async (calls) => {
    await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token, body: { logo_s3_key: second.key } });
    assert.deepEqual(calls.deleted, [first.key], 'the replaced logo is deleted');
  });
  assert.equal(await storageUsed(userId), 2 * MB, 'only the live logo is charged');

  // Clearing it releases the rest.
  await withStubbedS3(async () => {
    await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token, body: { logo_s3_key: null } });
  });
  assert.equal(await storageUsed(userId), 0);
});

test('an upload over the plan limit is refused and deleted, not stored', async () => {
  const userId = await userWithActivePlan(1, 9104);
  const token  = h.userTokenFor(userId);

  await withStorageLimitMb(5, async () => {
    // Fits.
    const ok = await uploadOf(token, 'user_frame', 4 * MB);
    assert.equal(ok.status, 200);
    assert.equal(await storageUsed(userId), 4 * MB);

    // 4 MB + 2 MB > 5 MB â€” refused, and the object is removed rather than left
    // behind active (it would never be swept: the lifecycle rule only sees pending).
    await withStubbedS3(async (calls) => {
      const key = (await h.request('POST', `${P}/uploads/presign`, {
        token, body: { target: { slot: 'user_frame' }, filename: 'big.png' },
      })).body.data.key;
      const over = await h.request('POST', `${P}/uploads/confirm`, { token, body: { keys: [key] } });
      assert.equal(over.status, 402, 'QUOTA_EXCEEDED');
      assert.deepEqual(calls.deleted, [key]);
      assert.deepEqual(calls.tagged, [], 'never promoted');
      assert.equal(await models.UserUpload.count({ where: { s3_key: key } }), 0, 'not on the books');
    }, { size: 2 * MB });

    assert.equal(await storageUsed(userId), 4 * MB, 'the rejected file did not change the total');

    // Once full, presign refuses up front rather than letting the client upload
    // a file that confirm would only throw away.
    await withStorageLimitMb(4, async () => {
      const r = await h.request('POST', `${P}/uploads/presign`, {
        token, body: { target: { slot: 'user_frame' }, filename: 'x.png' },
      });
      assert.equal(r.status, 402);
    });
  });
});

test('GET /subscriptions/me reports storage in MB, with exact bytes alongside', async () => {
  const userId = await userWithActivePlan(1, 9105);          // Free: 100 MB
  const token  = h.userTokenFor(userId);
  await uploadOf(token, 'user_frame', Math.round(2.5 * MB));

  const me = await h.request('GET', `${P}/subscriptions/me`, { token });
  assert.equal(me.status, 200);
  const storage = me.body.data.features.find((f) => f.key === 'storage');

  assert.equal(storage.unit, 'MB');
  assert.equal(storage.limit, 100);
  assert.equal(storage.used, 2.5);
  assert.equal(storage.remaining, 97.5, 'MB compared against MB â€” not 100 minus a byte count');
  assert.equal(storage.used_bytes, Math.round(2.5 * MB));

  // A plain counter is unchanged by the unit handling.
  const downloads = me.body.data.features.find((f) => f.key === 'downloads');
  assert.equal(downloads.unit, 'count');
  assert.equal(downloads.used_bytes, undefined);
});

test('an unlimited plan records storage but never blocks', async () => {
  const userId = await userWithActivePlan(2, 9106);          // Pro: unlimited
  const token  = h.userTokenFor(userId);

  const ok = await uploadOf(token, 'user_frame', 9 * MB);
  assert.equal(ok.status, 200);
  assert.equal(await storageUsed(userId), 9 * MB, 'still recorded, so a later policy change needs no backfill');

  const me = await h.request('GET', `${P}/subscriptions/me`, { token });
  const storage = me.body.data.features.find((f) => f.key === 'storage');
  assert.equal(storage.unlimited, true);
  assert.equal(storage.limit, null);
  assert.equal(storage.remaining, null);
});

test('releasing more than was charged floors the counter at zero', async () => {
  const userId = await userWithActivePlan(1, 9107);
  const quota  = require('../src/services/quota.service');

  await quota.consume(userId, 'storage', 1000);
  assert.equal(await storageUsed(userId), 1000);

  await quota.release(userId, 'storage', 5000);
  assert.equal(await storageUsed(userId), 0, 'never negative â€” that would read as free headroom');
});

test('deleting a product or a business releases the storage held underneath it', async () => {
  const userId = await userWithActivePlan(1, 9108);
  const token  = h.userTokenFor(userId);

  const logo = await uploadOf(token, 'business_logo', 1 * MB);
  const biz  = (await h.request('POST', `${P}/businesses`, {
    token, body: { name: `TST Cascade Biz ${Date.now()}`, industry: 'restaurant-food', logo_s3_key: logo.key },
  })).body.data;

  const mkProductWithImage = async (name, size) => {
    const product = (await h.request('POST', `${P}/products`, { token, body: { business_uid: biz.uid, name } })).body.data;
    const img = await uploadOf(token, 'product_image', size);
    await h.request('POST', `${P}/products/${product.uid}/images`, { token, body: { s3_key: img.key } });
    return { product, key: img.key };
  };

  const a = await mkProductWithImage('TST Cascade P1', 2 * MB);
  const b = await mkProductWithImage('TST Cascade P2', 3 * MB);
  assert.equal(await storageUsed(userId), 6 * MB, 'logo + two product images');

  // Deleting one product frees only its own image.
  await withStubbedS3(async (calls) => {
    assert.equal((await h.request('DELETE', `${P}/products/${a.product.uid}`, { token })).status, 200);
    assert.deepEqual(calls.deleted, [a.key]);
  });
  assert.equal(await storageUsed(userId), 4 * MB);

  // Deleting the business takes the logo and the surviving product's image.
  await withStubbedS3(async (calls) => {
    assert.equal((await h.request('DELETE', `${P}/businesses/${biz.uid}`, { token })).status, 200);
    assert.deepEqual(calls.deleted.sort(), [logo.key, b.key].sort());
  });
  assert.equal(await storageUsed(userId), 0, 'nothing stranded as permanently charged');
});

// ---------- Brand colours ----------
const mkBusinessFor = async (token, label) => (await h.request('POST', `${P}/businesses`, {
  token, body: { name: `TST ${label} ${Date.now()}${Math.random().toString(36).slice(2, 6)}`, industry: 'restaurant-food' },
})).body.data;

test('brand palette can be set at signup, and order is preserved as sent', async () => {
  const owner = await mkUser('Palette');
  const token = h.userTokenFor(owner.id);

  const created = await h.request('POST', `${P}/businesses`, {
    token,
    body: {
      name: `TST Palette Biz ${Date.now()}`,
      industry: 'restaurant-food',
      brand_colors: [
        { hex: '#ff0000', label: 'Brand Red' },
        { hex: '#00FF00' },
        { hex: '#0000ff', label: '  Deep Blue  ' },
      ],
    },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.data.brand_colors, [
    { hex: '#FF0000', label: 'Brand Red' },
    { hex: '#00FF00' },
    { hex: '#0000FF', label: 'Deep Blue' },
  ], 'upper-cased, labels trimmed, blank labels dropped, order untouched');
});

test('PUT /businesses/{uid}/brand-colors replaces the palette and is owner-only', async () => {
  const owner = await mkUser('PaletteMgr');
  const token = h.userTokenFor(owner.id);
  const biz   = await mkBusinessFor(token, 'PalMgr Biz');

  assert.deepEqual((await h.request('GET', `${P}/businesses/${biz.uid}/brand-colors`, { token })).body.data, [],
    'unset reads as an empty array, not null');

  const set = await h.request('PUT', `${P}/businesses/${biz.uid}/brand-colors`, {
    token, body: { brand_colors: [{ hex: '#123456' }, { hex: '#ABCDEF', label: 'Accent' }] },
  });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.data, [{ hex: '#123456' }, { hex: '#ABCDEF', label: 'Accent' }]);

  // Full replace, not a merge.
  const replaced = await h.request('PUT', `${P}/businesses/${biz.uid}/brand-colors`, {
    token, body: { brand_colors: [{ hex: '#FFFFFF' }] },
  });
  assert.deepEqual(replaced.body.data, [{ hex: '#FFFFFF' }]);

  const cleared = await h.request('PUT', `${P}/businesses/${biz.uid}/brand-colors`, { token, body: { brand_colors: [] } });
  assert.deepEqual(cleared.body.data, []);

  const stranger = await mkUser('PaletteStranger');
  assert.equal((await h.request('PUT', `${P}/businesses/${biz.uid}/brand-colors`, {
    token: h.userTokenFor(stranger.id), body: { brand_colors: [{ hex: '#000000' }] },
  })).status, 403);
});

test('brand palette rejects bad hex, duplicates and oversized palettes', async () => {
  const owner = await mkUser('PaletteBad');
  const token = h.userTokenFor(owner.id);
  const biz   = await mkBusinessFor(token, 'PalBad Biz');

  const put = (brand_colors) => h.request('PUT', `${P}/businesses/${biz.uid}/brand-colors`, { token, body: { brand_colors } });

  assert.equal((await put([{ hex: '#FFF' }])).status, 400, '3-digit shorthand is not accepted');
  assert.equal((await put([{ hex: 'FF0000' }])).status, 400, 'missing #');
  assert.equal((await put([{ hex: '#GGGGGG' }])).status, 400, 'not hex');
  assert.equal((await put([{ hex: '#FF0000' }, { hex: '#ff0000' }])).status, 400, 'same colour twice, case-insensitively');
  assert.equal((await put([
    { hex: '#111111' }, { hex: '#222222' }, { hex: '#333333' },
    { hex: '#444444' }, { hex: '#555555' }, { hex: '#666666' }, { hex: '#777777' },
  ])).status, 400, 'seven is over the cap');

  // Exactly six is fine.
  assert.equal((await put([
    { hex: '#111111' }, { hex: '#222222' }, { hex: '#333333' },
    { hex: '#444444' }, { hex: '#555555' }, { hex: '#666666' },
  ])).status, 200);

  // Nothing was written by any of the rejected calls.
  assert.equal((await h.request('GET', `${P}/businesses/${biz.uid}/brand-colors`, { token })).body.data.length, 6);
});

test('the brand palette stays out of the public storefront', async () => {
  const owner = await mkUser('PalettePrivate');
  const token = h.userTokenFor(owner.id);
  const biz   = (await h.request('POST', `${P}/businesses`, {
    token,
    body: {
      name: `TST Palette Private ${Date.now()}`, industry: 'restaurant-food',
      brand_colors: [{ hex: '#ABCDEF' }],
    },
  })).body.data;

  const pub = await h.request('GET', `${P}/businesses/${biz.uid}/public`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.data.brand_colors, undefined, 'a design input, not storefront content');

  // The owner still sees it.
  const mine = await h.request('GET', `${P}/businesses/${biz.uid}`, { token });
  assert.deepEqual(mine.body.data.brand_colors, [{ hex: '#ABCDEF' }]);
});

// ---------- JSON columns are parsed, not handed back as strings ----------
test('JSON columns come back parsed (they were returning raw strings)', async () => {
  const owner = await mkUser('JsonCols');
  const token = h.userTokenFor(owner.id);
  const biz = (await h.request('POST', `${P}/businesses`, {
    token,
    body: {
      name: `TST Json Biz ${Date.now()}`, industry: 'restaurant-food',
      social_links:    { instagram: 'https://example.test/a' },
      operating_hours: { mon: { open: '09:00', close: '18:00' } },
      brand_colors:    [{ hex: '#AABBCC' }],
    },
  })).body.data;

  assert.deepEqual(biz.social_links, { instagram: 'https://example.test/a' });
  assert.deepEqual(biz.operating_hours, { mon: { open: '09:00', close: '18:00' } });
  assert.deepEqual(biz.brand_colors, [{ hex: '#AABBCC' }]);

  // Same on the public storefront, which is where the FE reads them.
  const pub = await h.request('GET', `${P}/businesses/${biz.uid}/public`);
  assert.deepEqual(pub.body.data.social_links, { instagram: 'https://example.test/a' });
  assert.equal(typeof pub.body.data.operating_hours, 'object');

  const role = await models.Role.findByPk(2);
  assert.ok(Array.isArray(role.permissions), 'roles.permissions is an array, not a JSON string');
});

test('a wildcard role is not silently a superuser', async () => {
  // Regression: authorizeAdmin checks `perms.includes('*')`. While permissions came
  // back as the raw string '["templates.*","categories.*",...]' that was a SUBSTRING
  // test, which any wildcard satisfied â€” so content_admin passed the superuser gate
  // and could reach plans, coupons and admin-user management.
  const bcrypt = require('bcryptjs');
  const email  = `tst-content-admin-${Date.now()}@example.com`;
  const admin  = await models.AdminUser.create({
    uid: uuid(), name: 'TST Content Admin', email,
    password_hash: await bcrypt.hash('password123', 10), role_id: 2, is_active: 1,
  });

  try {
    const login = await h.request('POST', `${P}/auth/admin/login`, { body: { email, password: 'password123' } });
    assert.equal(login.status, 200);
    const token = login.body.data.access_token;

    // content_admin holds categories.* â€” still allowed in its own domains.
    assert.equal((await h.request('GET', `${P}/admin/business-categories`, { token })).status, 200);

    // ...and nowhere else.
    assert.equal((await h.request('GET', `${P}/admin/plans`, { token })).status, 403, 'plans are outside its grant');
    assert.equal((await h.request('GET', `${P}/admin/admins`, { token })).status, 403, 'admin management even more so');
  } finally {
    await admin.destroy();
  }
});

// ---------- Sessions, password & account settings ----------
const otpLogin = async (phone) => {
  const sent = await h.request('POST', `${P}/auth/send-otp`, { body: { phone, purpose: 'login' } });
  const r = await h.request('POST', `${P}/auth/verify-otp`, {
    body: { phone, otp: sent.body.data.otp, purpose: 'login', client_mnemonic: 'android' },
  });
  return r.body.data;
};

const newPhone = () => `7${String(Date.now()).slice(-9)}${Math.floor(Math.random() * 10)}`.slice(0, 10);

test('logout actually ends the session â€” the refresh token dies with it', async () => {
  const phone = newPhone();
  const t = await otpLogin(phone);
  const user = await User.findOne({ where: { phone } });
  track.users.push(user.id);

  // Before: the refresh token works.
  assert.equal((await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: t.refresh_token } })).status, 200);

  // Log in again (the refresh above rotated the first session) and log out.
  const t2 = await otpLogin(phone);
  assert.equal((await h.request('POST', `${P}/auth/logout`, { token: t2.access_token })).status, 200);

  // The access token is blacklisted...
  assert.equal((await h.request('GET', `${P}/users/me`, { token: t2.access_token })).status, 401);
  // ...and so is the refresh token, which previously survived logout entirely.
  const after = await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: t2.refresh_token } });
  assert.equal(after.status, 401, 'a logged-out session cannot mint new access tokens');
});

// ---------- Refresh token rotation & reuse detection ----------
const sidOf = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()).sid;

// A refresh token is single-use, so one that has already been rotated away turning
// up again means two parties hold the chain. Rejecting only the replayed token —
// which is all this used to do — leaves whoever refreshed FIRST holding a live
// token they can keep rotating for the session's full 30 days. If that was a thief,
// the real user sees nothing but one unexplained logout. So the whole account goes.
test('replaying a rotated refresh token signs every session out', async () => {
  const phone  = newPhone();
  const stolen = await otpLogin(phone);
  const user   = await User.findOne({ where: { phone } });
  track.users.push(user.id);

  // A second device, to prove the whole account goes and not just this session.
  const other = await otpLogin(phone);

  const rotated = await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: stolen.refresh_token } });
  assert.equal(rotated.status, 200);
  assert.equal(sidOf(rotated.body.data.access_token), sidOf(stolen.access_token), 'rotation keeps the same session');

  // Step outside the grace window, which otherwise (correctly) reads an immediate
  // replay as an innocent retry.
  await UserSession.update(
    { rotated_at: new Date(Date.now() - 60_000) },
    { where: { uid: sidOf(stolen.access_token) } },
  );

  const replay = await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: stolen.refresh_token } });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, 'TOKEN_REUSE_DETECTED');

  // The token the first refresh minted is dead too. This is the part that rejecting
  // only the replayed token missed entirely.
  assert.equal(
    (await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: rotated.body.data.refresh_token } })).status,
    401, 'the token minted by the first refresh no longer works',
  );
  // Immediate, via the access-token blacklist — not "in 15 minutes when it expires".
  assert.equal((await h.request('GET', `${P}/users/me`, { token: rotated.body.data.access_token })).status, 401);
  assert.equal((await h.request('GET', `${P}/users/me`, { token: other.access_token })).status, 401, 'and other devices');

  // Recorded: detection nobody can see afterwards is not worth much.
  const logged = await ActivityLog.findOne({
    where: { action: 'refresh_token_reuse_detected', actor_type: 'user', actor_id: user.id },
  });
  assert.ok(logged, 'reuse is written to the audit trail');
});

test('a refresh retried inside the grace window is a retry, not a break-in', async () => {
  const phone = newPhone();
  const t     = await otpLogin(phone);
  const user  = await User.findOne({ where: { phone } });
  track.users.push(user.id);

  const rotated = await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: t.refresh_token } });
  assert.equal(rotated.status, 200);

  // The same token again, immediately: a flaky connection re-sending, or two tabs
  // racing. It fails — but nothing is revoked, and the code says "retry".
  const retry = await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: t.refresh_token } });
  assert.equal(retry.status, 401);
  assert.equal(retry.body.error.code, 'REFRESH_IN_PROGRESS');

  // The point of the window: the user stays signed in.
  assert.equal((await h.request('GET', `${P}/users/me`, { token: rotated.body.data.access_token })).status, 200);
  assert.equal(
    (await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: rotated.body.data.refresh_token } })).status,
    200, 'the newest refresh token is unaffected',
  );
});

// Why the token is verified against its stored hash BEFORE the replay is acted on:
// knowing a session's previous jti must not be enough to trigger the account-wide
// sign-out, or reuse detection becomes a way to log any user out on demand.
//
// This also pins down why refresh tokens are stored as SHA-256 rather than bcrypt.
// bcrypt truncates at 72 bytes, and a JWT's first 72 bytes are the fixed header plus
// the opening of the payload — jti, iat, exp and the whole signature fall outside it.
// Under bcrypt this exact token verified against the stored hash and the account was
// signed out.
test('a token bearing a known prev_jti but the wrong body revokes nothing', async () => {
  const phone = newPhone();
  const t     = await otpLogin(phone);
  const user  = await User.findOne({ where: { phone } });
  track.users.push(user.id);

  const rotated = await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: t.refresh_token } });
  assert.equal(rotated.status, 200);

  const session = await UserSession.findOne({ where: { uid: sidOf(t.access_token) } });
  await session.update({ rotated_at: new Date(Date.now() - 60_000) });

  // Same jti as the replaced token, and deliberately identical up to and past byte
  // 72 — only `exp` and the signature differ. That is exactly the region bcrypt threw
  // away, so this token used to verify against the stored hash; under sha256 it does
  // not.
  const forged = jwt.sign(
    { sub: user.uid, userId: user.id, actor_type: 'user', jti: session.prev_jti },
    JWT_SECRET,
    { expiresIn: '31d' },
  );
  assert.notEqual(forged, t.refresh_token, 'the forged token really is a different token');

  const attempt = await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: forged } });
  assert.equal(attempt.status, 401);
  assert.equal(attempt.body.error.code, 'UNAUTHORIZED', 'rejected as a bad token, not treated as reuse');

  // The victim is untouched.
  assert.equal((await h.request('GET', `${P}/users/me`, { token: rotated.body.data.access_token })).status, 200);
  assert.equal(
    (await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: rotated.body.data.refresh_token } })).status,
    200, 'the real session still refreshes',
  );
});

// Rotation makes logout robust in a way it was not before. `sid` names the same
// session for the life of the login, so logging out with an access token from BEFORE
// a refresh still ends the session. Previously that sid pointed at the row the
// refresh had already revoked, the revoke matched nothing, and the refreshed pair
// sailed on for another 30 days.
test('logout with a pre-refresh access token still ends the live session', async () => {
  const phone = newPhone();
  const t     = await otpLogin(phone);
  const user  = await User.findOne({ where: { phone } });
  track.users.push(user.id);

  const rotated = await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: t.refresh_token } });
  assert.equal(rotated.status, 200);

  // Log out holding the OLD access token, from before the rotation.
  assert.equal((await h.request('POST', `${P}/auth/logout`, { token: t.access_token })).status, 200);

  // Both halves of the post-rotation pair are dead — the access token immediately,
  // via the blacklist, not in 15 minutes when it would have expired anyway.
  assert.equal((await h.request('GET', `${P}/users/me`, { token: rotated.body.data.access_token })).status, 401);
  assert.equal(
    (await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: rotated.body.data.refresh_token } })).status,
    401, 'the refreshed token cannot outlive the logout',
  );
});

// A device that refreshed recently holds TWO live access tokens: the new one and the
// one it replaced, still good for the rest of its 15 minutes. Revoking only the
// newest meant "sign out my other devices" reported success while leaving that device
// able to keep reading for another quarter of an hour.
test('revoke-others kills the access token a device held before its last refresh', async () => {
  const phone = newPhone();
  const a     = await otpLogin(phone);
  const user  = await User.findOne({ where: { phone } });
  track.users.push(user.id);
  const b = await otpLogin(phone);

  const rotated = await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: a.refresh_token } });
  assert.equal(rotated.status, 200);
  assert.equal(
    (await h.request('GET', `${P}/users/me`, { token: a.access_token })).status,
    200, 'the pre-refresh access token is still live — which is why it has to be revoked',
  );

  const revoked = await h.request('POST', `${P}/users/me/sessions/revoke-others`, { token: b.access_token });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.data.sessions_ended, 1);

  // Both of A's access tokens, not just the newest.
  assert.equal((await h.request('GET', `${P}/users/me`, { token: rotated.body.data.access_token })).status, 401);
  assert.equal(
    (await h.request('GET', `${P}/users/me`, { token: a.access_token })).status,
    401, 'and the one it was holding from before the refresh',
  );
  assert.equal((await h.request('GET', `${P}/users/me`, { token: b.access_token })).status, 200, 'the caller keeps working');
});

// Sessions that already existed when the SHA-256 switch shipped hold a bcrypt hash.
// They have to keep working — otherwise the deploy logs every user out — and they
// upgrade themselves on the next refresh.
test('a session stored with the old bcrypt hash still refreshes, and is upgraded', async () => {
  const phone = newPhone();
  const t     = await otpLogin(phone);
  const user  = await User.findOne({ where: { phone } });
  track.users.push(user.id);

  const session = await UserSession.findOne({ where: { uid: sidOf(t.access_token) } });
  await session.update({ refresh_token_hash: await bcrypt.hash(t.refresh_token, 10) });

  const refreshed = await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: t.refresh_token } });
  assert.equal(refreshed.status, 200, 'a pre-existing session is not invalidated by the change');

  await session.reload();
  assert.match(session.refresh_token_hash, /^[0-9a-f]{64}$/, 'rewritten as sha256 on rotation');
});

test('revoke-others signs out every other device immediately, keeping the current one', async () => {
  const phone = newPhone();
  const a = await otpLogin(phone);
  const user = await User.findOne({ where: { phone } });
  track.users.push(user.id);
  const b = await otpLogin(phone);
  const c = await otpLogin(phone);

  // All three are live.
  for (const t of [a, b, c]) {
    assert.equal((await h.request('GET', `${P}/users/me`, { token: t.access_token })).status, 200);
  }

  const revoked = await h.request('POST', `${P}/users/me/sessions/revoke-others`, { token: c.access_token });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.data.sessions_ended, 2);

  // Immediate â€” not "once the access token expires in 15 minutes".
  assert.equal((await h.request('GET', `${P}/users/me`, { token: a.access_token })).status, 401);
  assert.equal((await h.request('GET', `${P}/users/me`, { token: b.access_token })).status, 401);
  assert.equal((await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: a.refresh_token } })).status, 401);

  // The caller keeps working.
  assert.equal((await h.request('GET', `${P}/users/me`, { token: c.access_token })).status, 200);
});

test('set password: only when there is none, and it ends other sessions', async () => {
  const phone = newPhone();
  const a = await otpLogin(phone);
  const user = await User.findOne({ where: { phone } });
  track.users.push(user.id);
  const b = await otpLogin(phone);

  assert.equal((await h.request('GET', `${P}/users/me`, { token: b.access_token })).body.data.has_password, false);

  const set = await h.request('POST', `${P}/users/me/password`, { token: b.access_token, body: { new_password: 'sup3rsecret' } });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.sessions_ended, 1);

  assert.equal((await h.request('GET', `${P}/users/me`, { token: b.access_token })).body.data.has_password, true);
  assert.equal((await h.request('GET', `${P}/users/me`, { token: a.access_token })).status, 401, 'the other device was signed out');

  // A second set is refused â€” that would be a password change without proving the old one.
  const again = await h.request('POST', `${P}/users/me/password`, { token: b.access_token, body: { new_password: 'another1pass' } });
  assert.equal(again.status, 409);

  // Change works now, and needs the current password.
  assert.equal((await h.request('PATCH', `${P}/users/me/password`, {
    token: b.access_token, body: { current_password: 'wrongpass', new_password: 'another1pass' },
  })).status, 409);

  const changed = await h.request('PATCH', `${P}/users/me/password`, {
    token: b.access_token, body: { current_password: 'sup3rsecret', new_password: 'another1pass' },
  });
  assert.equal(changed.status, 200);
  assert.equal((await h.request('GET', `${P}/users/me`, { token: b.access_token })).status, 200, 'the caller stays signed in');

  // Too short is rejected.
  assert.equal((await h.request('POST', `${P}/users/me/password`, { token: b.access_token, body: { new_password: 'short' } })).status, 400);
});

test('deactivate ends everything and cannot be undone by logging in again', async () => {
  const phone = newPhone();
  const a = await otpLogin(phone);
  const user = await User.findOne({ where: { phone } });
  track.users.push(user.id);
  const b = await otpLogin(phone);

  const off = await h.request('POST', `${P}/users/me/deactivate`, { token: b.access_token });
  assert.equal(off.status, 200);

  await user.reload();
  assert.equal(user.is_active, 0);

  // Every session, including the caller's own.
  assert.equal((await h.request('GET', `${P}/users/me`, { token: a.access_token })).status, 401);
  assert.equal((await h.request('GET', `${P}/users/me`, { token: b.access_token })).status, 401);
  assert.equal((await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: b.refresh_token } })).status, 401);

  // And OTP does not let them straight back in.
  const sent = await h.request('POST', `${P}/auth/send-otp`, { body: { phone, purpose: 'login' } });
  const back = await h.request('POST', `${P}/auth/verify-otp`, {
    body: { phone, otp: sent.body.data.otp, purpose: 'login', client_mnemonic: 'android' },
  });
  assert.equal(back.status, 401, 'deactivation would be meaningless otherwise');
});

test('a deactivated owner disappears from the public directory but nothing is deleted', async () => {
  const phone = newPhone();
  const t = await otpLogin(phone);
  const user = await User.findOne({ where: { phone } });
  track.users.push(user.id);

  const biz = (await h.request('POST', `${P}/businesses`, {
    token: t.access_token,
    body: { name: `TST Deact Biz ${Date.now()}`, industry: 'restaurant-food', latitude: 12.97, longitude: 77.59 },
  })).body.data;

  assert.equal((await h.request('GET', `${P}/businesses/${biz.uid}/public`)).status, 200);
  const near = await h.request('GET', `${P}/businesses/nearby?lat=12.97&lng=77.59&radius=5`);
  assert.ok(near.body.data.some((b) => b.uid === biz.uid), 'listed while active');

  await h.request('POST', `${P}/users/me/deactivate`, { token: t.access_token });

  assert.equal((await h.request('GET', `${P}/businesses/${biz.uid}/public`)).status, 404, 'storefront gone');
  const nearAfter = await h.request('GET', `${P}/businesses/nearby?lat=12.97&lng=77.59&radius=5`);
  assert.ok(!nearAfter.body.data.some((b) => b.uid === biz.uid), 'delisted from Near Me');

  // The business row itself is untouched, so reactivating restores the listing.
  const row = await Business.findOne({ where: { uid: biz.uid } });
  assert.equal(row.is_active, 1, 'not soft-deleted â€” reactivation brings it back as it was');
});

test('notification preferences: defaults without a row, partial update, lazily created row', async () => {
  const u     = await mkUser('Prefs');
  const token = h.userTokenFor(u.id);

  const initial = await h.request('GET', `${P}/users/me/preferences`, { token });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.data.notify_push, true);
  assert.equal(initial.body.data.notify_email, true);
  assert.equal(initial.body.data.notify_whatsapp, true);
  assert.equal(await models.UserPreference.count({ where: { user_id: u.id } }), 0, 'no row written by a read');

  const patched = await h.request('PATCH', `${P}/users/me/preferences`, { token, body: { notify_email: false } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.notify_email, false);
  assert.equal(patched.body.data.notify_push, true, 'only what was sent changed');
  assert.equal(await models.UserPreference.count({ where: { user_id: u.id } }), 1, 'row created on first write');

  const again = await h.request('PATCH', `${P}/users/me/preferences`, { token, body: { notify_whatsapp: false } });
  assert.equal(again.body.data.notify_email, false, 'the earlier change survives');
  assert.equal(again.body.data.notify_whatsapp, false);

  assert.equal((await h.request('PATCH', `${P}/users/me/preferences`, { token, body: {} })).status, 400, 'empty body rejected');
  assert.equal((await h.request('GET', `${P}/users/me/preferences`, {})).status, 401);
});

// ---------- Preferred Languages (content languages for templates) ----------
test('GET /languages lists the picker options with native names', async () => {
  const r = await h.request('GET', `${P}/languages`);
  assert.equal(r.status, 200);
  const byCode = Object.fromEntries(r.body.data.map((l) => [l.code, l]));
  assert.ok(byCode.en && byCode.ta, 'seeded');
  assert.equal(byCode.ta.name, 'Tamil', 'English label for admin screens');
  assert.equal(byCode.ta.native_name, 'தமிழ்', 'what the picker renders');
  assert.equal(byCode.en.display_order, 1, 'English leads — it is the default');
});

test('preferred languages: default English until chosen, then a full replace', async () => {
  const u     = await mkUser('Langs');
  const token = h.userTokenFor(u.id);

  const initial = await h.request('GET', `${P}/users/me/preferences`, { token });
  assert.deepEqual(initial.body.data.languages.map((l) => l.code), ['en']);
  assert.equal(initial.body.data.languages_are_default, true, 'the user has not actually chosen yet');
  assert.equal(await models.UserLanguage.count({ where: { user_id: u.id } }), 0, 'the default is not written as rows');

  const set = await h.request('PATCH', `${P}/users/me/preferences`, { token, body: { languages: ['en', 'ml'] } });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.data.languages.map((l) => l.code).sort(), ['en', 'ml']);
  assert.equal(set.body.data.languages_are_default, false);

  // Full replace, not a merge.
  const replaced = await h.request('PATCH', `${P}/users/me/preferences`, { token, body: { languages: ['ta'] } });
  assert.deepEqual(replaced.body.data.languages.map((l) => l.code), ['ta']);

  // Clearing puts them back on the default.
  const cleared = await h.request('PATCH', `${P}/users/me/preferences`, { token, body: { languages: [] } });
  assert.deepEqual(cleared.body.data.languages.map((l) => l.code), ['en']);
  assert.equal(cleared.body.data.languages_are_default, true);

  // An unknown language is named in the 400 rather than silently dropped — the
  // saved filter must match what the screen showed.
  const bad = await h.request('PATCH', `${P}/users/me/preferences`, { token, body: { languages: ['en', 'zz'] } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.details.some((d) => d.message.includes('zz')));
});

test('template browse narrows to the viewer\'s languages, keeping language-neutral designs', async () => {
  const stamp = Date.now();
  const ta = await models.Language.findOne({ where: { code: 'ta' } });
  const ml = await models.Language.findOne({ where: { code: 'ml' } });

  const mk = async (label, languageId) => {
    const t = await Template.create({
      uid: uuid(), name: `TST Lang ${label} ${stamp}`, content: '{"c":1}', status: 'active',
      category_id: 2, language_id: languageId,
    });
    track.templates.push(t.id);
    return t;
  };
  const tamil   = await mk('Tamil', ta.id);
  const malay   = await mk('Malayalam', ml.id);
  const neutral = await mk('Neutral', null);

  const browse = async (token, qs = '') => {
    const r = await h.request('GET', `${P}/templates?category_id=2${qs}`, token ? { token } : {});
    return r.body.data.map((t) => t.uid);
  };

  const u     = await mkUser('LangBrowse');
  const token = h.userTokenFor(u.id);

  // No picks yet -> English + neutral. The Tamil and Malayalam ones are filtered out,
  // but the untagged design still shows.
  let uids = await browse(token);
  assert.ok(uids.includes(neutral.uid), 'language-neutral designs always show');
  assert.ok(!uids.includes(tamil.uid) && !uids.includes(malay.uid));

  await h.request('PATCH', `${P}/users/me/preferences`, { token, body: { languages: ['ta'] } });
  uids = await browse(token);
  assert.ok(uids.includes(tamil.uid), 'their chosen language appears');
  assert.ok(uids.includes(neutral.uid), 'neutral still comes through');
  assert.ok(!uids.includes(malay.uid), 'a language they did not choose does not');

  // ?language= overrides the saved picks (browsing a specific language).
  uids = await browse(token, '&language=ml');
  assert.ok(uids.includes(malay.uid) && !uids.includes(tamil.uid));

  // ?all_languages=1 opts out entirely — for SEO/landing pages.
  uids = await browse(token, '&all_languages=1');
  assert.ok([tamil.uid, malay.uid, neutral.uid].every((x) => uids.includes(x)));

  // Guests get the same default as a user who has not chosen.
  uids = await browse(null);
  assert.ok(uids.includes(neutral.uid) && !uids.includes(tamil.uid));
});

test('admin can set a template language, and languages are admin-managed', async () => {
  const token = h.adminToken(['*']);
  const stamp = Date.now();

  const created = await h.request('POST', `${P}/admin/languages`, {
    token, body: { code: 'zz', name: `TST Lang ${stamp}`, native_name: 'ZZ', display_order: 99 },
  });
  assert.equal(created.status, 201);
  const langId = created.body.data.id;

  // Duplicate code is a clean 409, not a raw DB error.
  assert.equal((await h.request('POST', `${P}/admin/languages`, {
    token, body: { code: 'zz', name: `TST Lang Dup ${stamp}`, native_name: 'ZZ2' },
  })).status, 409);

  const tpl = await Template.create({ uid: uuid(), name: `TST LangSet ${stamp}`, content: '{"c":1}', status: 'draft' });
  track.templates.push(tpl.id);
  const tagged = await h.request('PATCH', `${P}/admin/templates/${tpl.uid}`, { token, body: { language_id: langId } });
  assert.equal(tagged.status, 200);
  await tpl.reload();
  assert.equal(tpl.language_id, langId);

  // Deleting the language must not delete the designs drawn in it.
  assert.equal((await h.request('DELETE', `${P}/admin/languages/${created.body.data.uid}`, { token })).status, 200);
  await tpl.reload();
  assert.equal(tpl.language_id, null, 'the template survives, just untagged');
});

// ---------- Watermark (own branding, gated by the custom_watermark plan feature) ----------
test('watermark: free accounts cannot enable it, paid can, and turning it off always works', async () => {
  const freeId = await mkUser('WmFree').then((u) => u.id);
  const freeTok = h.userTokenFor(freeId);
  const biz = (await h.request('POST', `${P}/businesses`, {
    token: freeTok, body: { name: `TST WM Biz ${Date.now()}`, industry: 'restaurant-food' },
  })).body.data;

  assert.equal(biz.watermark_enabled, 0, 'off by default');
  assert.equal(biz.watermark_allowed, false, 'no plan, no entitlement');
  assert.equal(biz.watermark_active, false);

  const denied = await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token: freeTok, body: { watermark_enabled: 1 } });
  assert.equal(denied.status, 403, 'the paywall holds server-side, not just in the UI');

  // Grant Pro (plan 2 carries custom_watermark).
  const sub = await UserSubscription.create({
    uid: uuid(), user_id: freeId, plan_id: 2, sub_type: 'regular', status: 'active',
    starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 299,
  });

  const allowed = await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token: freeTok, body: { watermark_enabled: 1 } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.data.watermark_enabled, 1);
  assert.equal(allowed.body.data.watermark_active, true);

  // Plan lapses: the stored flag stays, but the capability is gone and
  // watermark_active says so â€” the app must stamp only when active is true.
  await sub.update({ status: 'expired' });
  const lapsed = await h.request('GET', `${P}/businesses/${biz.uid}`, { token: freeTok });
  assert.equal(lapsed.body.data.watermark_enabled, 1, 'their setting is remembered');
  assert.equal(lapsed.body.data.watermark_allowed, false);
  assert.equal(lapsed.body.data.watermark_active, false, 'so nothing is stamped');

  // Turning it OFF is always allowed â€” a lapsed plan must not trap the setting on.
  const off = await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token: freeTok, body: { watermark_enabled: 0 } });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.watermark_enabled, 0);
});

test('custom_watermark shows up as a normal boolean entitlement', async () => {
  const userId = await userWithActivePlan(2, 9201);       // Pro
  const me = await h.request('GET', `${P}/subscriptions/me`, { token: h.userTokenFor(userId) });
  const wm = me.body.data.features.find((f) => f.key === 'custom_watermark');
  assert.ok(wm, 'listed alongside the other entitlements');
  assert.equal(wm.data_type, 'boolean');
  assert.equal(wm.enabled, true);

  const freeId = await userWithActivePlan(1, 9202);       // Free
  const freeMe = await h.request('GET', `${P}/subscriptions/me`, { token: h.userTokenFor(freeId) });
  assert.equal(freeMe.body.data.features.find((f) => f.key === 'custom_watermark').enabled, false);
});

// ---------- Feedback ----------
test('feedback: rating required, message optional, signed-in users only', async () => {
  const u     = await mkUser('Feedback');
  const token = h.userTokenFor(u.id);

  assert.equal((await h.request('POST', `${P}/feedback`, { body: { rating: 5 } })).status, 401, 'registered users only');

  const sent = await h.request('POST', `${P}/feedback`, {
    token, body: { rating: 4, message: '  Love the templates  ', app_version: '2.4.1', platform: 'android' },
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.data.rating, 4);
  assert.ok(sent.body.data.uid);

  const row = await models.Feedback.findOne({ where: { uid: sent.body.data.uid } });
  assert.equal(row.message, 'Love the templates', 'trimmed');
  assert.equal(row.user_id, u.id);
  assert.equal(row.app_version, '2.4.1');

  // Rating alone is enough â€” the faces are the point of the form.
  const bare = await h.request('POST', `${P}/feedback`, { token, body: { rating: 1 } });
  assert.equal(bare.status, 201);
  const bareRow = await models.Feedback.findOne({ where: { uid: bare.body.data.uid } });
  assert.equal(bareRow.message, null);

  // A whitespace-only note is stored as "no comment", not as blank text.
  const blank = await h.request('POST', `${P}/feedback`, { token, body: { rating: 3, message: '   ' } });
  assert.equal((await models.Feedback.findOne({ where: { uid: blank.body.data.uid } })).message, null);

  // Out-of-range / missing ratings are refused.
  for (const body of [{}, { rating: 0 }, { rating: 6 }, { message: 'no rating' }]) {
    assert.equal((await h.request('POST', `${P}/feedback`, { token, body })).status, 400, JSON.stringify(body));
  }
});

test('admin can list and delete feedback, but not author it', async () => {
  const u     = await mkUser('FeedbackAdmin');
  const token = h.userTokenFor(u.id);
  const sent  = await h.request('POST', `${P}/feedback`, { token, body: { rating: 2, message: 'TST admin-visible note' } });
  assert.equal(sent.status, 201);

  const adminTok = h.adminToken(['*']);
  const list = await h.request('GET', `${P}/admin/feedback?limit=200`, { token: adminTok });
  assert.equal(list.status, 200);
  const mine = list.body.data.find((f) => f.uid === sent.body.data.uid);
  assert.ok(mine, 'appears in the admin list');
  assert.equal(mine.User.id, u.id, 'the submitter comes with it');
  assert.ok(typeof list.body.meta.total === 'number');

  // Filterable by rating.
  const filtered = await h.request('GET', `${P}/admin/feedback?rating=2&limit=200`, { token: adminTok });
  assert.ok(filtered.body.data.every((f) => f.rating === 2));

  // There is no admin create route â€” feedback is a record of what a user said.
  assert.equal((await h.request('POST', `${P}/admin/feedback`, { token: adminTok, body: { rating: 5 } })).status, 404);

  // Spam removal works.
  assert.equal((await h.request('DELETE', `${P}/admin/feedback/${sent.body.data.uid}`, { token: adminTok })).status, 200);
  assert.equal(await models.Feedback.count({ where: { uid: sent.body.data.uid } }), 0);

  // And needs the permission.
  const weak = h.adminToken(['categories.*']);
  assert.equal((await h.request('GET', `${P}/admin/feedback`, { token: weak })).status, 403);
});

// ---------- Media Library ("My Uploads") ----------
test('media library: upload with dimensions, list newest first, delete refunds storage', async () => {
  const userId = await userWithActivePlan(1, 9301);          // Free: 100 MB
  const token  = h.userTokenFor(userId);

  const upload = async (filename, size, width, height) => withStubbedS3(async () => {
    const key = (await h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot: 'media_library' }, filename },
    })).body.data.key;
    const r = await h.request('POST', `${P}/uploads/confirm`, {
      token, body: { uploads: [{ key, width, height, filename }] },
    });
    assert.equal(r.status, 200);
    return key;
  }, { size });

  const first  = await upload('beach-sunset.jpg', 2 * MB, 1920, 1080);
  const second = await upload('logo-draft.png', 1 * MB, 512, 512);

  assert.ok(first.startsWith(`users/${(await User.findByPk(userId)).uid}/media/`), 'its own prefix');
  assert.equal(await storageUsed(userId), 3 * MB, 'charged like any other upload');

  const list = await h.request('GET', `${P}/uploads`, { token });
  assert.equal(list.status, 200);
  assert.equal(list.body.meta.total, 2);
  assert.equal(list.body.data[0].s3_key, second, 'newest first');

  const item = list.body.data[0];
  assert.equal(item.width, 512);
  assert.equal(item.height, 512);
  assert.equal(item.original_filename, 'logo-draft.png', 'the uuid key would otherwise lose the name');
  assert.equal(item.slot, 'media_library');
  assert.equal(Number(item.bytes), 1 * MB);
  assert.equal(item.user_id, undefined, 'internal columns stay server-side');
  assert.equal(item.id, undefined);

  // Delete frees the storage and the object.
  await withStubbedS3(async (calls) => {
    const del = await h.request('DELETE', `${P}/uploads/${item.uid}`, { token });
    assert.equal(del.status, 200);
    assert.deepEqual(calls.deleted, [second]);
  });
  assert.equal(await storageUsed(userId), 2 * MB, 'refunded');
  assert.equal((await h.request('GET', `${P}/uploads`, { token })).body.meta.total, 1);
});

test('the media library shows only editor images, not logos or product images', async () => {
  const userId = await userWithActivePlan(1, 9302);
  const token  = h.userTokenFor(userId);

  const put = async (slot, size) => withStubbedS3(async () => {
    const key = (await h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot }, filename: 'f.png' },
    })).body.data.key;
    await h.request('POST', `${P}/uploads/confirm`, { token, body: { keys: [key] } });
    return key;
  }, { size });

  const media = await put('media_library', 1 * MB);
  const logo  = await put('business_logo', 1 * MB);

  const defaultList = await h.request('GET', `${P}/uploads`, { token });
  assert.deepEqual(defaultList.body.data.map((u) => u.s3_key), [media],
    'a logo cannot be deleted from the media grid by accident');

  // Other slots are reachable explicitly.
  const logos = await h.request('GET', `${P}/uploads?slot=business_logo`, { token });
  assert.deepEqual(logos.body.data.map((u) => u.s3_key), [logo]);

  // An unknown slot falls back to the library rather than erroring.
  const bogus = await h.request('GET', `${P}/uploads?slot=not_a_slot`, { token });
  assert.deepEqual(bogus.body.data.map((u) => u.s3_key), [media]);
});

test('uploads are owner-scoped: another user cannot list or delete yours', async () => {
  const mineId  = await userWithActivePlan(1, 9303);
  const token   = h.userTokenFor(mineId);
  const other   = await mkUser('MediaStranger');
  const otherTok = h.userTokenFor(other.id);

  const key = await withStubbedS3(async () => {
    const k = (await h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot: 'media_library' }, filename: 'private.png' },
    })).body.data.key;
    await h.request('POST', `${P}/uploads/confirm`, { token, body: { keys: [k] } });
    return k;
  }, { size: 1 * MB });

  const row = await models.UserUpload.findOne({ where: { s3_key: key } });

  assert.deepEqual((await h.request('GET', `${P}/uploads`, { token: otherTok })).body.data, [],
    'a stranger sees nothing of yours');

  // 404 rather than 403 â€” there is nothing to confirm to them.
  assert.equal((await h.request('DELETE', `${P}/uploads/${row.uid}`, { token: otherTok })).status, 404);
  assert.equal(await models.UserUpload.count({ where: { s3_key: key } }), 1, 'still there');

  assert.equal((await h.request('GET', `${P}/uploads`, {})).status, 401);
  assert.equal((await h.request('DELETE', `${P}/uploads/${row.uid}`, {})).status, 401);
});

test('confirm accepts either shape, but not both and not neither', async () => {
  const u     = await mkUser('MediaShape');
  const token = h.userTokenFor(u.id);

  await withStubbedS3(async () => {
    const key = (await h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot: 'media_library' }, filename: 'x.png' },
    })).body.data.key;

    // Legacy `keys` form still works â€” it just records no dimensions.
    assert.equal((await h.request('POST', `${P}/uploads/confirm`, { token, body: { keys: [key] } })).status, 200);
    const row = await models.UserUpload.findOne({ where: { s3_key: key } });
    assert.equal(row.width, null);
    assert.equal(row.original_filename, null);

    assert.equal((await h.request('POST', `${P}/uploads/confirm`, {
      token, body: { keys: [key], uploads: [{ key }] },
    })).status, 400, 'one shape or the other, not both');
    assert.equal((await h.request('POST', `${P}/uploads/confirm`, { token, body: {} })).status, 400);
  }, { size: 1024 });
});

// ---------- Brand Kit fonts ----------
const mkLibraryFont = async (family, { is_premium = 0, languageCodes = [] } = {}) => {
  const font = await models.Font.create({ uid: uuid(), user_id: null, family, is_premium, is_active: 1 });
  track.fonts.push(font.id);
  await models.FontFile.create({ font_id: font.id, weight: 400, style: 'normal', format: 'woff2', s3_key: `fonts/${font.uid}/regular.woff2` });
  if (languageCodes.length) {
    const langs = await models.Language.findAll({ where: { code: languageCodes } });
    await font.setLanguages(langs.map((l) => l.id));
  }
  return font;
};

test('GET /fonts shows the library, marks premium locked, and filters by script', async () => {
  const stamp = Date.now();
  const free  = await mkLibraryFont(`TST Free Sans ${stamp}`);
  const prem  = await mkLibraryFont(`TST Premium Serif ${stamp}`, { is_premium: 1 });
  const tamil = await mkLibraryFont(`TST Tamil Face ${stamp}`, { languageCodes: ['ta'] });

  const guest = await h.request('GET', `${P}/fonts`);
  assert.equal(guest.status, 200);
  const byUid = Object.fromEntries(guest.body.data.map((f) => [f.uid, f]));

  assert.equal(byUid[free.uid].is_locked, false);
  assert.ok(byUid[free.uid].FontFiles.length, 'files come with it');
  assert.equal(byUid[prem.uid].is_locked, true, 'premium is visible but locked');
  assert.equal(byUid[prem.uid].FontFiles, undefined, 'its files are withheld until upgrade');
  assert.equal(byUid[free.uid].user_id, undefined, 'ownership stays internal');

  // A paid viewer gets the premium files.
  const paidId = await userWithActivePlan(2, 9401);
  const paid = await h.request('GET', `${P}/fonts`, { token: h.userTokenFor(paidId, 'paid') });
  const paidPrem = paid.body.data.find((f) => f.uid === prem.uid);
  assert.equal(paidPrem.is_locked, false);
  assert.ok(paidPrem.FontFiles.length);

  // Script filter: the Tamil-tagged font plus every font with no declared coverage.
  const ta = await h.request('GET', `${P}/fonts?language=ta`);
  const taUids = ta.body.data.map((f) => f.uid);
  assert.ok(taUids.includes(tamil.uid), 'declared Tamil coverage');
  assert.ok(taUids.includes(free.uid), 'unclassified fonts are unknown, not incapable');

  const hi = await h.request('GET', `${P}/fonts?language=hi`);
  assert.ok(!hi.body.data.map((f) => f.uid).includes(tamil.uid), 'a Tamil-only face is not offered for Hindi');
});

test('a user can register a font they uploaded, and only from their own key', async () => {
  const u     = await mkUser('FontOwner');
  const token = h.userTokenFor(u.id);
  const other = await mkUser('FontStranger');

  // Font uploads are the one non-image slot.
  const key = await withStubbedS3(async () => {
    const presigned = await h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot: 'brand_font' }, filename: 'AcmeSans.woff2', content_type: 'font/woff2' },
    });
    assert.equal(presigned.status, 200);
    assert.ok(presigned.body.data.key.includes(`/fonts/`), 'its own prefix');
    await h.request('POST', `${P}/uploads/confirm`, { token, body: { keys: [presigned.body.data.key] } });
    return presigned.body.data.key;
  }, { size: 200 * 1024 });

  assert.equal(await storageUsed(u.id), 200 * 1024, 'counts against storage like any upload');

  const created = await h.request('POST', `${P}/fonts`, {
    token, body: { family: `TST Acme ${Date.now()}`, files: [{ s3_key: key, format: 'woff2' }] },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.is_own, true);
  assert.equal(created.body.data.FontFiles.length, 1);

  // It shows in MY list but not a stranger's.
  const mine = await h.request('GET', `${P}/fonts`, { token });
  assert.ok(mine.body.data.some((f) => f.uid === created.body.data.uid));
  const theirs = await h.request('GET', `${P}/fonts`, { token: h.userTokenFor(other.id) });
  assert.ok(!theirs.body.data.some((f) => f.uid === created.body.data.uid), 'private to its owner');

  // A key that was not issued to me for this slot is refused.
  const stolen = await h.request('POST', `${P}/fonts`, {
    token: h.userTokenFor(other.id),
    body: { family: 'TST Stolen', files: [{ s3_key: key, format: 'woff2' }] },
  });
  assert.equal(stolen.status, 400);

  // Deleting frees the storage; library fonts cannot be deleted.
  await withStubbedS3(async (calls) => {
    const del = await h.request('DELETE', `${P}/fonts/${created.body.data.uid}`, { token });
    assert.equal(del.status, 200);
    assert.deepEqual(calls.deleted, [key]);
  });
  assert.equal(await storageUsed(u.id), 0, 'refunded');

  const lib = await mkLibraryFont(`TST Undeletable ${Date.now()}`);
  assert.equal((await h.request('DELETE', `${P}/fonts/${lib.uid}`, { token })).status, 403);
});

test('font uploads reject images, and image slots reject fonts', async () => {
  const u     = await mkUser('FontTypes');
  const token = h.userTokenFor(u.id);

  const presign = (slot, filename, content_type) => h.request('POST', `${P}/uploads/presign`, {
    token, body: { target: { slot }, filename, ...(content_type ? { content_type } : {}) },
  });

  await withStubbedS3(async () => {
    assert.equal((await presign('brand_font', 'x.png', 'image/png')).status, 400, 'an image is not a font');
    assert.equal((await presign('brand_font', 'x.exe')).status, 400, 'extension is checked, not just the MIME type');
    assert.equal((await presign('media_library', 'x.woff2', 'font/woff2')).status, 400, 'a font is not an image');
    assert.equal((await presign('brand_font', 'x.ttf', 'application/octet-stream')).status, 200,
      'browsers send octet-stream for fonts; the extension carries the check');
  });
});

test('brand kit fonts: heading/body roles, gated by what the user may use', async () => {
  const stamp = Date.now();
  const freeFont = await mkLibraryFont(`TST Kit Sans ${stamp}`);
  const premFont = await mkLibraryFont(`TST Kit Serif ${stamp}`, { is_premium: 1 });

  const u     = await mkUser('FontKit');
  const token = h.userTokenFor(u.id);
  const biz   = (await h.request('POST', `${P}/businesses`, {
    token, body: { name: `TST Font Biz ${stamp}`, industry: 'restaurant-food' },
  })).body.data;

  const set = await h.request('PATCH', `${P}/businesses/${biz.uid}`, {
    token, body: { heading_font_id: freeFont.id, body_font_id: freeFont.id },
  });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.headingFont.family, freeFont.family);
  assert.equal(set.body.data.bodyFont.family, freeFont.family);

  // A premium library font needs the plan â€” checked against the DB, not the token's claim.
  const denied = await h.request('PATCH', `${P}/businesses/${biz.uid}`, {
    token, body: { heading_font_id: premFont.id },
  });
  assert.equal(denied.status, 403);

  await UserSubscription.create({
    uid: uuid(), user_id: u.id, plan_id: 2, sub_type: 'regular', status: 'active',
    starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 299,
  });
  assert.equal((await h.request('PATCH', `${P}/businesses/${biz.uid}`, {
    token, body: { heading_font_id: premFont.id },
  })).status, 200, 'allowed once subscribed');

  // An unknown font id is a clean 400, and null clears the role.
  assert.equal((await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token, body: { body_font_id: 99999999 } })).status, 400);
  const cleared = await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token, body: { body_font_id: null } });
  assert.equal(cleared.body.data.body_font_id, null);

  // Deleting a font must not delete the businesses styled with it.
  const own = await models.Font.create({ uid: uuid(), user_id: u.id, family: `TST Doomed ${stamp}`, is_active: 1 });
  await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token, body: { body_font_id: own.id } });
  await own.destroy();
  const after = await h.request('GET', `${P}/businesses/${biz.uid}`, { token });
  assert.equal(after.status, 200, 'the business survives');
  assert.equal(after.body.data.body_font_id, null, 'the reference is nulled, not orphaned');
});

test('admin library fonts: name unique among library rows only, files and scripts replaceable', async () => {
  const token = h.adminToken(['*']);
  const stamp = Date.now();
  const family = `TST Admin Face ${stamp}`;

  const created = await h.request('POST', `${P}/admin/fonts`, { token, body: { family, is_premium: 0 } });
  assert.equal(created.status, 201);
  track.fonts.push(created.body.data.id);

  assert.equal((await h.request('POST', `${P}/admin/fonts`, { token, body: { family } })).status, 409,
    'two library fonts cannot share a name');

  // ...but a USER may name their own font the same thing.
  const u = await mkUser('FontNameClash');
  const own = await models.Font.create({ uid: uuid(), user_id: u.id, family, is_active: 1 });
  assert.ok(own.id, 'a private font is not blocked by the library name');

  const withFiles = await h.request('PUT', `${P}/admin/fonts/${created.body.data.uid}/files`, {
    token,
    body: { files: [
      { s3_key: 'fonts/a/regular.woff2', format: 'woff2', weight: 400 },
      { s3_key: 'fonts/a/bold.woff2',    format: 'woff2', weight: 700 },
    ] },
  });
  assert.equal(withFiles.status, 200);
  assert.equal(withFiles.body.data.FontFiles.length, 2, 'a family is many files');

  // Full replace, not append.
  const replaced = await h.request('PUT', `${P}/admin/fonts/${created.body.data.uid}/files`, {
    token, body: { files: [{ s3_key: 'fonts/a/only.ttf', format: 'ttf' }] },
  });
  assert.equal(replaced.body.data.FontFiles.length, 1);

  const ta = await models.Language.findOne({ where: { code: 'ta' } });
  const scoped = await h.request('PUT', `${P}/admin/fonts/${created.body.data.uid}/languages`, {
    token, body: { language_ids: [ta.id] },
  });
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.body.data.Languages.map((l) => l.code), ['ta']);
});

// ---------- Admin panel enablement fixes ----------
test('content_admin can reach fonts and languages, but not feedback or plans', async () => {
  const bcrypt = require('bcryptjs');
  const email  = `tst-content-perms-${Date.now()}@example.com`;
  const admin  = await models.AdminUser.create({
    uid: uuid(), name: 'TST Content Perms', email,
    password_hash: await bcrypt.hash('password123', 10), role_id: 2, is_active: 1,
  });

  try {
    const login = await h.request('POST', `${P}/auth/admin/login`, { body: { email, password: 'password123' } });
    assert.equal(login.status, 200);
    const token = login.body.data.access_token;

    // Granted by the migration, so the Fonts and Languages screens work.
    assert.equal((await h.request('GET', `${P}/admin/fonts`, { token })).status, 200);
    assert.equal((await h.request('GET', `${P}/admin/languages`, { token })).status, 200);

    // Feedback carries submitter PII and is deliberately NOT granted.
    assert.equal((await h.request('GET', `${P}/admin/feedback`, { token })).status, 403);
    // And the domain boundary still holds elsewhere.
    assert.equal((await h.request('GET', `${P}/admin/plans`, { token })).status, 403);
  } finally {
    await admin.destroy();
  }
});

test('the role permission migration is additive and idempotent', async () => {
  const role = await models.Role.findOne({ where: { name: 'content_admin' } });
  const perms = role.permissions;

  assert.ok(Array.isArray(perms), 'parsed, not a raw JSON string');
  for (const p of ['languages.*', 'fonts.*']) assert.ok(perms.includes(p), `${p} granted`);
  assert.ok(!perms.includes('feedback.*'), 'feedback stays with super_admin');

  // The domains it already had survived â€” the migration appends, never replaces.
  for (const p of ['templates.*', 'categories.*', 'assets.*']) assert.ok(perms.includes(p), `${p} preserved`);
  assert.equal(new Set(perms).size, perms.length, 'no duplicates from a re-run');
});

test('an admin deactivating a user ends their sessions immediately', async () => {
  const phone = newPhone();
  const a = await otpLogin(phone);
  const user = await User.findOne({ where: { phone } });
  track.users.push(user.id);
  const b = await otpLogin(phone);

  // Both live before the ban.
  for (const t of [a, b]) {
    assert.equal((await h.request('GET', `${P}/users/me`, { token: t.access_token })).status, 200);
  }

  const banned = await h.request('PATCH', `${P}/admin/users/${user.uid}/status`, {
    token: h.adminToken(['*']), body: { is_active: 0 },
  });
  assert.equal(banned.status, 200);

  // Immediate â€” not "once the access token expires".
  assert.equal((await h.request('GET', `${P}/users/me`, { token: a.access_token })).status, 401);
  assert.equal((await h.request('GET', `${P}/users/me`, { token: b.access_token })).status, 401);
  assert.equal((await h.request('POST', `${P}/auth/refresh`, { body: { refresh_token: b.refresh_token } })).status, 401);

  // Reactivating does not revoke anything further; the user simply logs in again.
  const back = await h.request('PATCH', `${P}/admin/users/${user.uid}/status`, {
    token: h.adminToken(['*']), body: { is_active: 1 },
  });
  assert.equal(back.status, 200);
  const fresh = await otpLogin(phone);
  assert.equal((await h.request('GET', `${P}/users/me`, { token: fresh.access_token })).status, 200);
});

test('admin batch presign signs mixed targets, and refuses the whole batch if one is bad', async () => {
  const token = h.adminToken(['*']);

  await withStubbedS3(async () => {
    const r = await h.request('POST', `${P}/admin/uploads/presign`, {
      token,
      body: { files: [
        { target: { type: 'image_slot', slot: 'banner' },        filename: 'hero.png' },
        { target: { type: 'asset', asset_type: 'icon' },         filename: 'star.svg' },   // admins may upload SVG
        { target: { type: 'image_slot', slot: 'variant_badge_icon' }, filename: 'badge.png' },
      ] },
    });
    assert.equal(r.status, 200);

    const [banner, icon, badge] = r.body.data.files;
    assert.ok(banner.key.startsWith('banners/') && banner.key.endsWith('.png'));
    assert.ok(icon.key.startsWith('assets/icon/'), 'targets may be mixed within a batch');
    assert.ok(badge.key.startsWith('variants/badge-icon/'));
    assert.equal(new Set(r.body.data.files.map((f) => f.key)).size, 3);
    assert.ok(r.body.data.files.every((f) => f.upload_url && f.required_headers['x-amz-tagging'] === 'status=pending'));
    assert.equal(r.body.data.expires_in, 900, 'reported once, not per file');

    // The single-file shape is untouched, and the two cannot be combined.
    const single = await h.request('POST', `${P}/admin/uploads/presign`, {
      token, body: { target: { type: 'image_slot', slot: 'banner' }, filename: 'solo.png' },
    });
    assert.equal(single.status, 200);
    assert.ok(single.body.data.key && !single.body.data.files, 'flat shape preserved');
    assert.equal((await h.request('POST', `${P}/admin/uploads/presign`, {
      token, body: { target: { type: 'image_slot', slot: 'banner' }, filename: 'x.png', files: [] },
    })).status, 400);

    // One unknown slot fails the batch before any URL is issued, naming the entry.
    const bad = await h.request('POST', `${P}/admin/uploads/presign`, {
      token,
      body: { files: [
        { target: { type: 'image_slot', slot: 'banner' },  filename: 'ok.png' },
        { target: { type: 'image_slot', slot: 'nonsense' }, filename: 'no.png' },
      ] },
    });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error.details.some((d) => d.field.startsWith('files.1')), 'error points at the offending entry');

    const tooMany = Array.from({ length: 51 }, (_, i) => ({ target: { type: 'image_slot', slot: 'banner' }, filename: `f${i}.png` }));
    assert.equal((await h.request('POST', `${P}/admin/uploads/presign`, { token, body: { files: tooMany } })).status, 400);

    // Multipart is one key and one upload_id — it must not inherit the batch form.
    assert.equal((await h.request('POST', `${P}/admin/uploads/multipart/initiate`, {
      token, body: { files: [{ target: { type: 'image_slot', slot: 'banner' }, filename: 'big.png' }] },
    })).status, 400);
  });
});

test('admin confirm reports each key separately and keeps the good ones', async () => {
  const token = h.adminToken(['*']);

  await withStubbedS3(async (calls) => {
    const keys = (await h.request('POST', `${P}/admin/uploads/presign`, {
      token,
      body: { files: [
        { target: { type: 'image_slot', slot: 'banner' }, filename: 'a.png' },
        { target: { type: 'image_slot', slot: 'banner' }, filename: 'b.png' },
      ] },
    })).body.data.files.map((f) => f.key);

    const outside = 'etc/passwd.png';                       // outside every allowed root
    const r = await h.request('POST', `${P}/admin/uploads/confirm`, {
      token, body: { keys: [keys[0], outside, keys[1]] },
    });

    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.results.map((x) => x.status), ['confirmed', 'rejected', 'confirmed']);
    assert.deepEqual(r.body.data.keys, [keys[0], keys[1]], 'keys lists the confirmed ones only');
    assert.deepEqual(calls.tagged, [[keys[0], 'active'], [keys[1], 'active']], 'the bad key was never promoted');

    // Every key bad = the request itself fails, as it always did for a single key.
    assert.equal((await h.request('POST', `${P}/admin/uploads/confirm`, {
      token, body: { keys: [outside] },
    })).status, 400);
  });
});

test('a font can no longer be filed as an asset â€” fonts belong to the fonts library', async () => {
  const token = h.adminToken(['*']);
  const stamp = Date.now();

  // Creating an asset of type font is rejected: it would land somewhere the Brand
  // Kit can never see, with no way to express weights or script coverage.
  const asAsset = await h.request('POST', `${P}/admin/assets`, {
    token, body: { name: `TST Font Asset ${stamp}`, s3_key: 'assets/font/x.woff2', asset_type: 'font' },
  });
  assert.equal(asAsset.status, 400);

  // Nor can one be uploaded down that path.
  const presigned = await h.request('POST', `${P}/admin/uploads/presign`, {
    token, body: { target: { type: 'asset', asset_type: 'font' }, filename: 'x.woff2' },
  });
  assert.equal(presigned.status, 400);

  // The remaining asset types are untouched.
  const ok = await h.request('POST', `${P}/admin/assets`, {
    token, body: { name: `TST Icon Asset ${stamp}`, s3_key: 'assets/icon/x.png', asset_type: 'icon' },
  });
  assert.equal(ok.status, 201);
  track.assets.push(ok.body.data.id);

  // One list, not four copies drifting apart.
  const { ASSET_TYPES } = require('../src/utils/assetTypes');
  assert.ok(!ASSET_TYPES.includes('font'));
  assert.deepEqual(require('../src/services/upload.service').ASSET_TYPES, ASSET_TYPES);
});
