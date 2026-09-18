const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { v4: uuid } = require('uuid');
const h = require('./helpers');

const { models } = h;
const { User, Business, Template, UserSubscription, Payment, ActivityLog, OtpCode, UserSession } = models;
const { hashOtp } = require('../src/utils/otpHelper');
const { toE164 }  = require('../src/utils/phone');
const jwt = require('jsonwebtoken');

// Login phones are stored in E.164 whatever spelling the request used, so a test
// that logs in with a bare 10-digit number has to look the row up canonically.
const userByPhone = (phone) => User.findOne({ where: { phone: toE164(phone) } });
const bcrypt = require('bcryptjs');
const { JWT_SECRET } = require('../src/config/jwt');

const P = '/api/v1';
let startLogId = 0;
const track = { users: [], templates: [], variants: [], brandSeries: [], variantBadges: [], stylePersonalities: [], colors: [], faqCategories: [], faqs: [], testimonials: [], tags: [], templateSizes: [], businessCategories: [], templateCategories: [], assets: [], assetCategories: [], coupons: [], fonts: [], frames: [], frameCategories: [], quotaPacks: [], notificationTemplates: [], notificationCategories: [], notificationCampaigns: [], pageSections: [] };

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
  // Before the industries: an industry-scoped section cascades away with its
  // industry, but a DEFAULT section (business_category_id null) does not.
  if (track.pageSections.length) await models.PageSection.destroy({ where: { id: track.pageSections } }); // cascades page_section_items
  if (track.businessCategories.length) await models.BusinessCategory.destroy({ where: { id: track.businessCategories } });
  if (track.templateCategories.length) await models.TemplateCategory.destroy({ where: { id: track.templateCategories } });
  if (track.assets.length)             await models.Asset.destroy({ where: { id: track.assets } });
  if (track.assetCategories.length)    await models.AssetCategory.destroy({ where: { id: track.assetCategories } });
  if (track.users.length)     await User.destroy({ where: { id: track.users } }); // cascades (incl. subscriptions)
  if (track.fonts.length)     await models.Font.destroy({ where: { id: track.fonts } }); // cascades files + languages
  // AFTER users: user_frames pins its frame with ON DELETE RESTRICT, so the
  // ownership rows have to go with their owner before the frame itself can.
  if (track.frames.length)          await models.Frame.destroy({ where: { id: track.frames } });
  if (track.frameCategories.length) await models.FrameCategory.destroy({ where: { id: track.frameCategories } });
  // Also after users: a grant pins its pack, and grants go with their owner.
  if (track.quotaPacks.length) await models.QuotaPack.destroy({ where: { id: track.quotaPacks } });
  if (track.coupons.length)   await models.Coupon.destroy({ where: { id: track.coupons } }); // cascades plan restrictions
  // Notifications go AFTER users (user_notifications cascades with its owner) and
  // in dependency order: an inbox row pins its template with ON DELETE RESTRICT,
  // so campaigns and templates can only go once their rows are gone.
  if (track.notificationCampaigns.length) {
    await models.UserNotification.destroy({ where: { campaign_id: track.notificationCampaigns } });
    await models.NotificationCampaign.destroy({ where: { id: track.notificationCampaigns } });
  }
  if (track.notificationTemplates.length) {
    await models.UserNotification.destroy({ where: { template_id: track.notificationTemplates } });
    await models.NotificationTemplate.destroy({ where: { id: track.notificationTemplates } });
  }
  if (track.notificationCategories.length) {
    await models.NotificationCategory.destroy({ where: { id: track.notificationCategories } });
  }
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

  const u = await userByPhone(phone);
  if (u) track.users.push(u.id);
});

test('verify-otp rejects a wrong OTP', async () => {
  const phone = `9${String((Date.now() + 7) % 1000000000).padStart(9, '0')}`;
  await h.request('POST', `${P}/auth/send-otp`, { body: { phone, purpose: 'login' } });
  const verify = await h.request('POST', `${P}/auth/verify-otp`, {
    body: { phone, otp: '000000', purpose: 'login', client_mnemonic: 'android' },
  });
  assert.equal(verify.status, 401);
  const u = await userByPhone(phone);
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

  const u = await userByPhone(phone);
  if (u) track.users.push(u.id);
});

// The Flutter app sends +91XXXXXXXXXX and the web app sends the bare 10 digits.
// Stored raw, those were two accounts: a profile completed on mobile was "missing"
// on web. Every spelling must land on the same row, stored as E.164.
test('the same number in any spelling is one account, stored as +91', async () => {
  const local = `8${String(Date.now()).slice(-9)}`;
  const login = async (phone) => {
    const sent = await h.request('POST', `${P}/auth/send-otp`, { body: { phone, purpose: 'login' } });
    assert.equal(sent.status, 200, `send-otp rejected ${phone}`);
    const r = await h.request('POST', `${P}/auth/verify-otp`, {
      body: { phone, otp: sent.body.data.otp, purpose: 'login', client_mnemonic: 'web' },
    });
    assert.equal(r.status, 200, `verify-otp rejected ${phone}`);
    return JSON.parse(Buffer.from(r.body.data.access_token.split('.')[1], 'base64').toString()).userId;
  };

  const first = await login(`+91${local}`);            // mobile app
  track.users.push(first);
  assert.equal(await login(local),            first, 'web app: bare 10 digits');
  assert.equal(await login(`91${local}`),     first, 'country code without the plus');
  assert.equal(await login(`0${local}`),      first, 'trunk prefix');
  assert.equal(await login(`+91 ${local.slice(0, 5)}-${local.slice(5)}`), first, 'spaces and hyphens');

  const rows = await User.findAll({ where: { phone: { [require('sequelize').Op.like]: `%${local}` } } });
  assert.equal(rows.length, 1, 'exactly one row for the number');
  assert.equal(rows[0].phone, `+91${local}`, 'stored canonically');
});

// The normaliser everything above (and the OTP rate-limit key, which cannot be
// exercised here since limiting is skipped under NODE_ENV=test) is built on.
test('toE164 canonicalises every Indian spelling and nothing else', () => {
  const { toE164, normalizePhone } = require('../src/utils/phone');
  for (const s of ['9876543210', '+919876543210', '919876543210', '09876543210', '+91 98765-43210', '(+91) 98765 43210']) {
    assert.equal(toE164(s), '+919876543210', s);
  }
  for (const s of ['+14155552671', '5876543210', '987654321', '98765432101', '+9198765432', '', null, undefined, 'abc']) {
    assert.equal(toE164(s), null, `${s} is not an Indian mobile`);
  }
  assert.equal(normalizePhone('+14155552671'), '+14155552671', 'non-Indian passes through untouched');
});

// India-only, stated at validation rather than discovered at SMS time (which used to
// write an OTP row first and then 400).
test('send-otp refuses anything that is not an Indian mobile', async () => {
  for (const phone of ['+14155552671', '12345', '5123456789', '+91512345678', 'abc']) {
    const r = await h.request('POST', `${P}/auth/send-otp`, { body: { phone, purpose: 'login' } });
    assert.equal(r.status, 400, `${phone} should be refused`);
  }
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

test('import assets: stores the thumbnail alongside the file, clears it with NONE, warns on a bad prefix', async () => {
  const token = h.adminToken(['assets.*']);
  const stamp = Date.now();
  const cat = await models.AssetCategory.create({ name: `IMP Thumb Cat ${stamp}`, slug: `imp-thumb-cat-${stamp}` });
  track.assetCategories.push(cat.id);
  const iconKey  = `assets/icon/thumb-${stamp}.svg`;
  const thumbKey = `assets/thumbnail/thumb-${stamp}.png`;
  const strayKey = `assets/icon/stray-thumb-${stamp}.png`;   // a thumbnail filed with the deliverables
  const audioKey = `assets/audio/thumb-${stamp}.mp3`;

  const present = {
    [iconKey]: { content_type: 'image/svg+xml' }, [thumbKey]: { content_type: 'image/png' },
    [strayKey]: { content_type: 'image/png' }, [audioKey]: { content_type: 'audio/mpeg' },
  };
  const rows = (thumbCell) => [
    'category,name,asset_type,s3_key,thumbnail_s3_key,is_premium,status,tags',
    `${cat.slug},IMP Premium ${stamp},icon,${iconKey},${thumbCell},1,active,`,
    // an mp3 has no preview of its own, so its thumbnail is an image either way
    `${cat.slug},IMP Chime ${stamp},audio,${audioKey},${strayKey},1,active,`,
  ].join('\n');

  const { result: res, tagged } = await withS3Objects(present, () => importCsv('assets', rows(thumbKey), { token }));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.summary.created, 2);

  const assets = await models.Asset.findAll({ where: { category_id: cat.id } });
  track.assets.push(...assets.map((a) => a.id));
  const icon = assets.find((a) => a.asset_type === 'icon');
  assert.equal(icon.thumbnail_s3_key, thumbKey, 'thumbnail saved next to the file');
  assert.ok(tagged.some(([k]) => k === thumbKey), 'the thumbnail is flipped to status=active too');

  // The audio row's thumbnail sits under assets/audio-adjacent icon space — advisory only.
  const strayWarnings = res.body.data.rows.flatMap((r) => r.warnings).join(' | ');
  assert.match(strayWarnings, /thumbnail_s3_key: expected a key under 'assets\/thumbnail\/'/);
  const audio = assets.find((a) => a.asset_type === 'audio');
  assert.equal(audio.thumbnail_s3_key, strayKey, 'still imported — a misfiled key is a warning, not a skip');

  // Blank keeps what is stored; NONE clears it.
  await withS3Objects(present, () => importCsv('assets', rows(''), { token }));
  await icon.reload();
  assert.equal(icon.thumbnail_s3_key, thumbKey, 'blank cell leaves the thumbnail alone');

  await withS3Objects(present, () => importCsv('assets', rows('NONE'), { token }));
  await icon.reload();
  assert.equal(icon.thumbnail_s3_key, null, 'NONE removes the thumbnail');
  assert.equal(icon.s3_key, iconKey, 'the deliverable is untouched');
});

test('import assets: skips unknown category, blank s3_key, bad asset_type and files missing from S3; warns on shape problems', async () => {
  const token = h.adminToken(['assets.*']);
  const stamp = Date.now();
  const cat = await models.AssetCategory.create({ name: `IMP Warn Cat ${stamp}`, slug: `imp-warn-cat-${stamp}` });
  track.assetCategories.push(cat.id);
  const strayKey = `assets/emoji/stray-${stamp}.png`;   // wrong folder for an icon, present in the bucket
  const ghostKey = `assets/icon/ghost-${stamp}.svg`;    // well-formed, but never uploaded
  const okKey    = `assets/icon/ok-${stamp}.svg`;
  const noThumb  = `assets/thumbnail/ghost-${stamp}.png`; // thumbnail never uploaded
  const dupKey   = `assets/icon/dup-${stamp}.svg`;
  const noCatKey = `assets/icon/x-${stamp}.svg`;
  const badTypeKey = `assets/icon/y-${stamp}.svg`;

  const csv = [
    'category,name,asset_type,s3_key,thumbnail_s3_key,is_premium,status,tags',
    `No Such Category ${stamp},IMP NoCat ${stamp},icon,${noCatKey},,0,active,`,                // unknown category -> skip
    `${cat.slug},IMP NoFile ${stamp},icon,,,0,active,`,                                        // no file -> skip
    `${cat.slug},IMP BadType ${stamp},sticker,${badTypeKey},,0,active,`,                       // bad asset_type -> skip
    `${cat.slug},IMP Ghost ${stamp},icon,${ghostKey},,0,active,`,                              // file not in S3 -> skip
    `${cat.slug},IMP GhostThumb ${stamp},icon,${okKey},${noThumb},1,active,`,                  // thumbnail not in S3 -> skip
    `${cat.slug},IMP Stray ${stamp},icon,${strayKey},,0,active,`,                              // wrong prefix -> warning only
    `${cat.slug},IMP Dup A ${stamp},icon,${dupKey},,0,active,`,
    `${cat.slug},IMP Dup B ${stamp},icon,${dupKey},,0,active,`,                                // same file -> updates the row above
  ].join('\n');

  const present = {
    [dupKey]: { content_type: 'image/svg+xml' },
    [okKey]: { content_type: 'image/svg+xml' },
    [strayKey]: { content_type: 'image/png' },
    // these files are real; only the category / asset_type on their rows is wrong
    [noCatKey]: { content_type: 'image/svg+xml' },
    [badTypeKey]: { content_type: 'image/svg+xml' },
  };
  const { result: res, tagged } = await withS3Objects(present, () => importCsv('assets', csv, { token }));
  assert.equal(res.status, 200);
  const rows = res.body.data.rows;
  const row = (n) => rows.find((r) => r.name === `IMP ${n} ${stamp}`);
  assert.match(row('NoCat').message, /category 'No Such Category .*' not found/);
  assert.match(row('NoCat').message, /import asset-categories/);
  assert.match(row('NoFile').message, /s3_key is required/);
  assert.match(row('BadType').message, /asset_type/);
  assert.equal(row('Ghost').status, 'skipped', 'an asset whose file is not in S3 is not imported');
  assert.match(row('Ghost').message, /s3_key: no such object in S3/);
  assert.match(row('Ghost').message, /upload the file first/);
  assert.equal(row('GhostThumb').status, 'skipped', 'a missing thumbnail blocks the row too');
  assert.match(row('GhostThumb').message, /thumbnail_s3_key: no such object in S3/);
  assert.equal(res.body.data.summary.skipped, 5);

  assert.equal(row('Stray').status, 'created', 'shape problems on an existing file stay advisory');
  const strayWarnings = row('Stray').warnings.join(' | ');
  assert.match(strayWarnings, /expected a key under 'assets\/icon\/'/);
  assert.doesNotMatch(strayWarnings, /no such object/);
  assert.match(row('Dup B').warnings.join(' | '), /same file as line \d+ — that record is updated, not duplicated/);
  assert.equal(row('Dup A').status, 'created');
  assert.equal(row('Dup B').status, 'updated');
  assert.deepEqual(tagged.map(([k]) => k).sort(), [dupKey, strayKey].sort(), 'only files behind a saved row are tagged');

  const made = await models.Asset.findAll({ where: { category_id: cat.id } });
  assert.equal(made.length, 2, 'stray + one deduplicated row; no phantom rows for missing files');
  assert.ok(!made.some((a) => a.s3_key === ghostKey || a.s3_key === okKey), 'neither skipped row reached the table');
  assert.equal(made.find((a) => a.s3_key === dupKey).name, `IMP Dup B ${stamp}`, 'second row won the key');
  track.assets.push(...made.map((a) => a.id));
});

test('import assets: refuses the whole file when S3 cannot be checked (no unverified asset rows)', async () => {
  const s3 = require('../src/utils/s3Helper');
  const original = { objectExists: s3.objectExists, putObjectTagging: s3.putObjectTagging };
  s3.objectExists = async () => null;               // "could not check"
  const token = h.adminToken(['assets.*']);
  const stamp = Date.now();
  const cat = await models.AssetCategory.create({ name: `IMP NoBucket Cat ${stamp}`, slug: `imp-nobucket-cat-${stamp}` });
  track.assetCategories.push(cat.id);
  const key = `assets/icon/nobucket-${stamp}.svg`;
  const csv = [
    'category,name,asset_type,s3_key,is_premium,status,tags',
    `${cat.slug},IMP NoBucket ${stamp},icon,${key},0,active,`,
  ].join('\n');
  try {
    const res = await importCsv('assets', csv, { token });
    assert.equal(res.status, 400, 'unlike industries, an unverifiable bucket is fatal for assets');
    assert.match(res.body.error.message, /could not be verified/);
    assert.match(res.body.error.message, /Nothing was written/);
  } finally { Object.assign(s3, original); }
  assert.equal(await models.Asset.count({ where: { s3_key: key } }), 0, 'no row slipped through');
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

// ---- Asset file audit: GET reports, DELETE removes the rows whose S3 file is gone ----
test('asset file audit: reports missing files, deletes only confirmed-404 rows, leaves unverified alone', async () => {
  const s3 = require('../src/utils/s3Helper');
  const stamp = Date.now();
  const cat = await models.AssetCategory.create({ name: `AUD Cat ${stamp}`, slug: `aud-cat-${stamp}` });
  track.assetCategories.push(cat.id);
  const otherCat = await models.AssetCategory.create({ name: `AUD Other ${stamp}`, slug: `aud-other-${stamp}` });
  track.assetCategories.push(otherCat.id);

  const goodKey   = `assets/icon/aud-good-${stamp}.svg`;
  const goodThumb = `assets/thumbnail/aud-good-${stamp}.png`;
  const ghostKey  = `assets/icon/aud-ghost-${stamp}.svg`;      // file gone
  const okKey     = `assets/icon/aud-thumbless-${stamp}.svg`;
  const goneThumb = `assets/thumbnail/aud-gone-${stamp}.png`;  // thumbnail gone, file fine
  const flakyKey  = `assets/icon/aud-flaky-${stamp}.svg`;      // S3 errors (not 404)
  const otherKey  = `assets/bg/aud-other-${stamp}.jpg`;        // gone, but in another category

  const [good, ghost, thumbless, flaky, other] = await Promise.all([
    models.Asset.create({ category_id: cat.id, name: `AUD Good ${stamp}`, asset_type: 'icon', s3_key: goodKey, thumbnail_s3_key: goodThumb }),
    models.Asset.create({ category_id: cat.id, name: `AUD Ghost ${stamp}`, asset_type: 'icon', s3_key: ghostKey }),
    models.Asset.create({ category_id: cat.id, name: `AUD Thumbless ${stamp}`, asset_type: 'icon', s3_key: okKey, thumbnail_s3_key: goneThumb, is_premium: 1 }),
    models.Asset.create({ category_id: cat.id, name: `AUD Flaky ${stamp}`, asset_type: 'icon', s3_key: flakyKey }),
    models.Asset.create({ category_id: otherCat.id, name: `AUD Other ${stamp}`, asset_type: 'bg', s3_key: otherKey }),
  ]);
  track.assets.push(good.id, ghost.id, thumbless.id, flaky.id, other.id);
  const tag = await models.Tag.create({ name: `aud-tag-${stamp}`, slug: `aud-tag-${stamp}` });
  track.tags.push(tag.id);
  await ghost.setTags([tag]);

  const present = { [goodKey]: {}, [goodThumb]: {}, [okKey]: {} };
  const original = s3.objectExists;
  s3.objectExists = async (key) => {
    if (key === flakyKey) return null;                       // "could not check"
    return Object.prototype.hasOwnProperty.call(present, key) ? { exists: true, content_type: 'image/png', size: 1 } : { exists: false };
  };

  try {
    // Read-only report, scoped to one category.
    const reader = h.adminToken(['assets.read']);
    const scan = await h.request('GET', `${P}/admin/assets/missing-files?category_id=${cat.id}`, { token: reader });
    assert.equal(scan.status, 200);
    const d = scan.body.data;
    assert.deepEqual(d.summary, { scanned: 4, missing: 2, unverified: 1 });
    const byName = (list, n) => list.find((r) => r.name === `AUD ${n} ${stamp}`);
    assert.deepEqual(byName(d.missing, 'Ghost').missing, ['s3_key']);
    assert.deepEqual(byName(d.missing, 'Thumbless').missing, ['thumbnail_s3_key'], 'a missing thumbnail alone flags the row');
    assert.equal(byName(d.missing, 'Ghost').uid, ghost.uid);
    assert.equal(byName(d.missing, 'Ghost').category.slug, cat.slug, 'category carried so the row can be found in the panel');
    assert.equal(byName(d.unverified, 'Flaky').name, `AUD Flaky ${stamp}`);
    assert.match(d.notes.join(' '), /could not be verified/);
    assert.ok(!byName(d.missing, 'Other'), 'category_id filter respected');
    assert.equal(await models.Asset.count({ where: { id: [ghost.id, thumbless.id] } }), 2, 'GET writes nothing');

    // Reader cannot delete.
    const denied = await h.request('DELETE', `${P}/admin/assets/missing-files?category_id=${cat.id}`, { token: reader });
    assert.equal(denied.status, 403);

    // Bad filter.
    const bad = await h.request('GET', `${P}/admin/assets/missing-files?asset_type=sticker`, { token: reader });
    assert.equal(bad.status, 400);

    // category_id=0 means the uncategorised rows (NULL), not a literal 0.
    const loose = await models.Asset.create({ category_id: null, name: `AUD Loose ${stamp}`, asset_type: 'icon', s3_key: `assets/icon/aud-loose-${stamp}.svg` });
    track.assets.push(loose.id);
    const uncategorised = await h.request('GET', `${P}/admin/assets/missing-files?category_id=0`, { token: reader });
    assert.equal(uncategorised.status, 200);
    assert.ok(uncategorised.body.data.missing.some((r) => r.uid === loose.uid), 'uncategorised row found via category_id=0');
    assert.ok(!uncategorised.body.data.missing.some((r) => r.uid === ghost.uid), 'categorised rows excluded');

    // Delete, scoped to the category: ghost + thumbless go, flaky and good stay, other untouched.
    const purge = await h.request('DELETE', `${P}/admin/assets/missing-files?category_id=${cat.id}`, { token: h.adminToken(['assets.*']) });
    assert.equal(purge.status, 200);
    assert.deepEqual(purge.body.data.summary, { scanned: 4, missing: 2, unverified: 1, deleted: 2 });
    assert.equal(await models.Asset.count({ where: { id: [ghost.id, thumbless.id] } }), 0, 'confirmed-missing rows removed');
    assert.equal(await models.Asset.count({ where: { id: [good.id, flaky.id, other.id] } }), 3, 'good, unverified and out-of-scope rows survive');
    assert.equal(await models.AssetTag.count({ where: { asset_id: ghost.id } }), 0, 'tag links cascade');

    const log = await ActivityLog.findOne({ where: { action: 'asset.purged_missing_files' }, order: [['id', 'DESC']] });
    assert.ok(log, 'purge is logged');

    // Second pass finds nothing left to do.
    const again = await h.request('DELETE', `${P}/admin/assets/missing-files?category_id=${cat.id}`, { token: h.adminToken(['assets.*']) });
    assert.equal(again.body.data.summary.deleted, 0);
  } finally { s3.objectExists = original; }
});

test('asset file audit: refuses to run when nothing can be checked', async () => {
  const s3 = require('../src/utils/s3Helper');
  const stamp = Date.now();
  const cat = await models.AssetCategory.create({ name: `AUD NoS3 Cat ${stamp}`, slug: `aud-nos3-cat-${stamp}` });
  track.assetCategories.push(cat.id);
  const row = await models.Asset.create({ category_id: cat.id, name: `AUD NoS3 ${stamp}`, asset_type: 'icon', s3_key: `assets/icon/aud-nos3-${stamp}.svg` });
  track.assets.push(row.id);

  const original = s3.objectExists;
  s3.objectExists = async () => null;
  try {
    const res = await h.request('DELETE', `${P}/admin/assets/missing-files?category_id=${cat.id}`, { token: h.adminToken(['assets.*']) });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /could not be checked|unreachable/);
  } finally { s3.objectExists = original; }
  assert.equal(await models.Asset.count({ where: { id: row.id } }), 1, 'nothing deleted on an inconclusive scan');
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

// ---- Page content (the editorial blocks under the template grid) ----
// A distinct page_key per test keeps these from colliding with each other or with
// whatever the real 'industry' page holds in a seeded database.
const makeSection = async (pageKey, sectionKey, over = {}) => {
  const row = await models.PageSection.create({
    uid: uuid(), page_key: pageKey, section_key: sectionKey, business_category_id: null,
    heading: 'Default heading', display_order: 0, is_active: 1, ...over,
  });
  track.pageSections.push(row.id);
  return row;
};

test('page sections: an industry inherits the defaults, overrides one key, and hides another', async () => {
  const stamp    = Date.now();
  const pageKey  = `tst_p${stamp}`;
  const industry = await makeIndustry('PageContent', stamp);

  // Three shared defaults, in page order.
  await makeSection(pageKey, 'why_choose',      { display_order: 10, heading: 'Why Choose Us' });
  const ideas = await makeSection(pageKey, 'content_ideas',  { display_order: 20, heading: 'Content for Every {{industry}} Need' });
  await makeSection(pageKey, 'business_growth', { display_order: 30, subheading: 'videos for your {{industry_lower}} brand.' });

  const items = await Promise.all([
    models.PageSectionItem.create({ uid: uuid(), section_id: ideas.id, title: 'Festival Greetings', display_order: 1 }),
    models.PageSectionItem.create({ uid: uuid(), section_id: ideas.id, title: 'Promotional Offers', display_order: 0 }),
    models.PageSectionItem.create({ uid: uuid(), section_id: ideas.id, title: 'Hidden', display_order: 2, is_active: 0 }),
  ]);

  const url = `${P}/page-sections?page=${pageKey}&industry=${industry.slug}`;

  // Nothing overridden yet: all three defaults, in display_order, tokens filled
  // in from the industry being served.
  const inherited = await h.request('GET', url);
  assert.equal(inherited.status, 200);
  assert.deepEqual(inherited.body.data.map((s) => s.section_key), ['why_choose', 'content_ideas', 'business_growth']);
  assert.ok(inherited.body.data.every((s) => s.inherited), 'every block is the shared default');
  assert.equal(inherited.body.data[1].heading, `Content for Every ${industry.name} Need`, '{{industry}} substituted');
  assert.equal(inherited.body.data[2].subheading, `videos for your ${industry.name.toLowerCase()} brand.`, '{{industry_lower}} substituted');
  assert.deepEqual(inherited.body.data[1].items.map((i) => i.title), ['Promotional Offers', 'Festival Greetings'],
    'items in display_order, inactive one dropped');

  // An override wins for its key alone; the other two keep inheriting.
  await makeSection(pageKey, 'content_ideas', { business_category_id: industry.id, display_order: 20, heading: 'Bespoke copy' });
  const overridden = await h.request('GET', url);
  assert.equal(overridden.body.data[1].heading, 'Bespoke copy');
  assert.equal(overridden.body.data[1].inherited, false);
  assert.deepEqual(overridden.body.data[1].items, [], 'the override starts with no items of its own');
  assert.ok(overridden.body.data[0].inherited && overridden.body.data[2].inherited, 'other keys still inherit');

  // An INACTIVE override is how an industry hides an inherited block — the
  // default must not resurface in its place.
  await makeSection(pageKey, 'why_choose', { business_category_id: industry.id, display_order: 10, is_active: 0 });
  const hidden = await h.request('GET', url);
  assert.deepEqual(hidden.body.data.map((s) => s.section_key), ['content_ideas', 'business_growth'],
    'the hidden block is gone, not replaced by its default');

  // Another industry is untouched by any of it.
  const other = await makeIndustry('PageContentOther', stamp);
  const untouched = await h.request('GET', `${P}/page-sections?page=${pageKey}&industry=${other.slug}`);
  assert.deepEqual(untouched.body.data.map((s) => s.section_key), ['why_choose', 'content_ideas', 'business_growth']);
  assert.equal(untouched.body.data[1].heading, `Content for Every ${other.name} Need`, 'defaults re-render per industry');

  await models.PageSectionItem.destroy({ where: { id: items.map((i) => i.id) } });
  assert.equal((await h.request('GET', `${P}/page-sections?page=${pageKey}&industry=nope-${stamp}`)).status, 404);
});

test('page sections ride along on /industries/{ref}', async () => {
  const stamp    = Date.now();
  const industry = await makeIndustry('PageDetail', stamp);
  await makeSection('industry', `tst_only_${stamp}`, { heading: 'Everything You Need, {{industry}}' });

  const detail = await h.request('GET', `${P}/industries/${industry.slug}`);
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.body.data.sections), 'landing page gets its copy in the same call');
  const mine = detail.body.data.sections.find((s) => s.section_key === `tst_only_${stamp}`);
  assert.equal(mine.heading, `Everything You Need, ${industry.name}`);
});

test('admin page sections: scope uniqueness, clone, reorder and permission gate', async () => {
  const stamp    = Date.now();
  const pageKey  = `tst_a${stamp}`;
  const token    = h.adminToken(['page_content.*']);
  const industry = await makeIndustry('PageAdmin', stamp);
  const url      = `${P}/admin/page-sections`;

  const mk = async (body) => {
    const res = await h.request('POST', url, { token, body: { page_key: pageKey, ...body } });
    if (res.status === 201) track.pageSections.push(res.body.data.id);
    return res;
  };

  const first = await mk({ section_key: 'why_choose', heading: 'Default' });
  assert.equal(first.status, 201);

  // MySQL allows unlimited NULLs in a unique index, so nothing at the schema
  // level catches a SECOND default for the same key — the guard is beforeWrite.
  assert.equal((await mk({ section_key: 'why_choose', heading: 'Dupe' })).status, 409, 'duplicate default rejected');

  // The same key scoped to an industry is a legitimate override, not a clash.
  const override = await mk({ section_key: 'why_choose', business_category_id: industry.id, heading: 'Mine' });
  assert.equal(override.status, 201);
  assert.equal((await mk({ section_key: 'why_choose', business_category_id: industry.id })).status, 409, 'duplicate override rejected');
  assert.equal((await mk({ section_key: 'why_choose', business_category_id: 999999 })).status, 404, 'unknown industry is a 404, not a raw FK error');

  // Items hang off a section and are ordered by drag, not by insertion.
  const itemUrl = `${P}/admin/page-section-items`;
  const a = await h.request('POST', itemUrl, { token, body: { section_id: first.body.data.id, title: 'Card A' } });
  const b = await h.request('POST', itemUrl, { token, body: { section_id: first.body.data.id, title: 'Card B' } });
  assert.equal(a.status, 201);
  assert.equal((await h.request('POST', itemUrl, { token, body: { section_id: 999999, title: 'Orphan' } })).status, 404);
  assert.equal((await h.request('POST', itemUrl, { token, body: { section_id: first.body.data.id } })).status, 400, 'an item with no content at all is rejected');

  const reorder = await h.request('PATCH', `${itemUrl}/reorder`, { token, body: { ids: [b.body.data.uid, a.body.data.uid] } });
  assert.equal(reorder.status, 200);
  const listed = await h.request('GET', `${itemUrl}?section_id=${first.body.data.id}`, { token });
  assert.deepEqual(listed.body.data.map((i) => i.title), ['Card B', 'Card A'], 'drag order round-trips');

  // Clone refuses while the industry already owns that key...
  const clone = (body) => h.request('POST', `${url}/clone`, { token, body: { page_key: pageKey, business_category_id: industry.id, ...body } });
  assert.equal((await clone({})).status, 409, 'will not overwrite copy the industry already has');

  // ...and copies the defaults, with their items, once it doesn't.
  await models.PageSection.destroy({ where: { id: override.body.data.id } });
  const cloned = await clone({});
  assert.equal(cloned.status, 201);
  track.pageSections.push(...cloned.body.data.map((s) => s.id));
  assert.deepEqual(cloned.body.data.map((s) => s.section_key), ['why_choose']);
  const clonedItems = await models.PageSectionItem.findAll({ where: { section_id: cloned.body.data[0].id } });
  assert.deepEqual(clonedItems.map((i) => i.title).sort(), ['Card A', 'Card B'], 'items came across too');
  assert.equal((await clone({ section_keys: [`nope_${stamp}`] })).status, 404, 'unknown section_key is a 404');

  // Preview resolves exactly as the public read does.
  const preview = await h.request('GET', `${url}/preview?page_key=${pageKey}&industry_id=${industry.id}`, { token });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.find((s) => s.section_key === 'why_choose').inherited, false, 'the clone is now the industry\'s own');

  // The editor has to be able to list the shared defaults, which is only
  // expressible if 'null' means IS NULL.
  const defaults = await h.request('GET', `${url}?page_key=${pageKey}&business_category_id=null`, { token });
  assert.equal(defaults.status, 200);
  assert.ok(defaults.body.data.length && defaults.body.data.every((s) => s.business_category_id === null),
    'business_category_id=null lists the defaults, not the empty set');
  const mine = await h.request('GET', `${url}?page_key=${pageKey}&industry_id=${industry.id}`, { token });
  assert.ok(mine.body.data.every((s) => s.business_category_id === industry.id), 'industry_id alias scopes to the overrides');

  // Read permission alone cannot author copy.
  const readOnly = h.adminToken(['page_content.read']);
  assert.equal((await h.request('POST', url, { token: readOnly, body: { page_key: pageKey, section_key: 'nope' } })).status, 403);
  assert.equal((await h.request('GET', url, { token: readOnly })).status, 200);
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

  // supplied-but-unresolved anchor => empty page, not 400. Still true now that
  // category is optional: absent and unresolved must not collapse together, or a
  // typo'd slug would return the whole library instead of nothing.
  const bad = await h.request('GET', `${P}/assets?category=no-such-asset-cat`);
  assert.equal(bad.status, 200);
  assert.equal(bad.body.data.length, 0, 'bad category slug yields empty');

  // neither anchor => 400
  assert.equal((await h.request('GET', `${P}/assets`)).status, 400);
});

test('public /assets: asset_type anchors the browse on its own', async () => {
  const stamp = Date.now();
  const cat = await models.AssetCategory.create({ uid: uuid(), name: `TST Type Cat ${stamp}`, slug: `tst-type-cat-${stamp}`, is_active: 1 });
  track.assetCategories.push(cat.id);

  const inCat = await models.Asset.create({ uid: uuid(), category_id: cat.id, name: `TST Typed ${stamp}`, s3_key: 'k/typed.mp3', asset_type: 'audio', status: 'active', is_premium: 0 });
  track.assets.push(inCat.id);
  // Category is nullable and both the admin create and the CSV import leave it
  // optional, so orphans like this one exist. Reaching them is the point of the
  // second anchor — a category-only endpoint never could.
  const orphan = await models.Asset.create({ uid: uuid(), category_id: null, name: `TST Orphan ${stamp}`, s3_key: 'k/orphan.mp3', asset_type: 'audio', status: 'active', is_premium: 0 });
  track.assets.push(orphan.id);

  const has = (r, a) => r.body.data.some((x) => x.uid === a.uid);

  // Type alone spans categories, including the orphan. The shared test DB holds
  // other audio assets, so assert membership rather than an exact page.
  const byType = await h.request('GET', `${P}/assets?asset_type=audio&limit=100`);
  assert.equal(byType.status, 200);
  assert.ok(has(byType, inCat),  'type anchor finds the categorized asset');
  assert.ok(has(byType, orphan), 'type anchor reaches the uncategorized asset');

  // Both anchors combine.
  const both = await h.request('GET', `${P}/assets?category=${cat.slug}&asset_type=audio`);
  assert.ok(has(both, inCat),   'category + type finds the categorized asset');
  assert.ok(!has(both, orphan), 'category + type excludes the other category');

  // A mismatched type narrows to nothing rather than falling back to the category.
  const mismatch = await h.request('GET', `${P}/assets?category=${cat.slug}&asset_type=video`);
  assert.equal(mismatch.status, 200);
  assert.ok(!has(mismatch, inCat), 'non-matching type excludes the asset');

  // 'null' is the uncategorized anchor.
  const uncategorized = await h.request('GET', `${P}/assets?category=null&asset_type=audio&limit=100`);
  assert.equal(uncategorized.status, 200);
  assert.ok(has(uncategorized, orphan),  'category=null lists uncategorized assets');
  assert.ok(!has(uncategorized, inCat),  'category=null excludes categorized assets');

  // An unknown type is a 400, NOT a silently dropped filter: as an anchor, a
  // dropped `asset_type=icons` would hand back the entire library.
  assert.equal((await h.request('GET', `${P}/assets?asset_type=icons`)).status, 400);
  // 'font' is in the DB enum but not an accepted asset type (fonts live in `fonts`).
  assert.equal((await h.request('GET', `${P}/assets?asset_type=font`)).status, 400);
});

test('public /assets: a locked premium asset keeps its thumbnail but loses its file', async () => {
  const stamp = Date.now();
  const cat = await models.AssetCategory.create({ uid: uuid(), name: `TST Lock Cat ${stamp}`, slug: `tst-lock-cat-${stamp}`, is_active: 1 });
  track.assetCategories.push(cat.id);

  const thumb = `assets/thumbnail/prem-${stamp}.png`;
  const premium = await models.Asset.create({
    uid: uuid(), category_id: cat.id, name: `TST Premium ${stamp}`, asset_type: 'icon',
    s3_key: `assets/icon/prem-${stamp}.svg`, thumbnail_s3_key: thumb, status: 'active', is_premium: 1,
  });
  // A free asset with no thumbnail of its own — the client falls back to s3_key.
  const free = await models.Asset.create({
    uid: uuid(), category_id: cat.id, name: `TST Free ${stamp}`, asset_type: 'icon',
    s3_key: `assets/icon/free-${stamp}.svg`, status: 'active', is_premium: 0,
  });
  track.assets.push(premium.id, free.id);

  const find = (r, uid) => r.body.data.find((a) => a.uid === uid);

  for (const [label, opts] of [['guest', {}], ['free user', { token: h.userTokenFor(1, 'free') }]]) {
    const res = await h.request('GET', `${P}/assets?category=${cat.slug}`, opts);
    assert.equal(res.status, 200);

    const p = find(res, premium.uid);
    assert.equal(p.is_locked, true, `${label}: premium asset is locked`);
    assert.equal(p.s3_key, undefined, `${label}: the file is withheld`);
    assert.equal(p.thumbnail_s3_key, thumb, `${label}: the thumbnail is still served, so the card can be drawn`);

    const f = find(res, free.uid);
    assert.equal(f.is_locked, false, `${label}: free asset is not locked`);
    assert.equal(f.s3_key, free.s3_key, `${label}: free asset keeps its file`);
    assert.equal(f.thumbnail_s3_key, null, `${label}: no separate thumbnail — client falls back to s3_key`);
  }

  // A paid viewer gets both keys on the premium row.
  const paid = await h.request('GET', `${P}/assets?category=${cat.slug}`, { token: h.userTokenFor(1, 'paid') });
  const unlocked = find(paid, premium.uid);
  assert.equal(unlocked.is_locked, false, 'paid viewer: not locked');
  assert.equal(unlocked.s3_key, premium.s3_key, 'paid viewer: gets the file');
  assert.equal(unlocked.thumbnail_s3_key, thumb, 'paid viewer: still gets the thumbnail');
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

// ---------- Products & services ----------
test('products and services: type-specific fields, offer price, and the inactive tab vs delete', async () => {
  const u = await User.create({ uid: uuid(), name: 'TST PS', phone: `7${String((Date.now() + 7) % 1000000000).padStart(9, '0')}` });
  track.users.push(u.id);
  const biz   = await Business.create({ uid: uuid(), user_id: u.id, name: 'TST PS Biz' });
  const token = h.userTokenFor(u.id);
  const post  = (body) => h.request('POST', `${P}/products`, { token, body: { business_uid: biz.uid, ...body } });
  const list  = (q = '') => h.request('GET', `${P}/products?business_uid=${biz.uid}${q}`, { token });
  const pub   = (q = '') => h.request('GET', `${P}/businesses/${biz.uid}/products${q}`);

  // A product carries unit + an offer price below its actual price.
  const cake = await post({ name: 'Red Velvet Cake', unit: '1 Kg', price: 800, offer_price: 750, description: 'Moist' });
  assert.equal(cake.status, 201, JSON.stringify(cake.body));
  assert.equal(cake.body.data.type, 'product', 'type defaults to product');
  assert.equal(cake.body.data.unit, '1 Kg');
  assert.equal(Number(cake.body.data.offer_price), 750);

  // A service carries service_area instead.
  const paint = await post({ type: 'service', name: 'Wall Painting', service_area: 'Nagercoil', price: 5000 });
  assert.equal(paint.status, 201, JSON.stringify(paint.body));
  assert.equal(paint.body.data.service_area, 'Nagercoil');

  // The other type's detail, and an offer above the actual price, are rejected.
  const r1 = await post({ type: 'service', name: 'Bad', unit: '1 Kg' });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error.details[0].field, 'unit');
  const r2 = await post({ name: 'Bad', service_area: 'Here' });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.error.details[0].field, 'service_area');
  const r3 = await post({ name: 'Bad', price: 100, offer_price: 150 });
  assert.equal(r3.status, 400);
  assert.equal(r3.body.error.details[0].field, 'offer_price');
  const r4 = await post({ name: 'Bad', offer_price: 50 });
  assert.equal(r4.status, 400, 'offer_price without a price');
  // ...and the offer is checked against the STORED price on a partial update.
  const r5 = await h.request('PATCH', `${P}/products/${cake.body.data.uid}`, { token, body: { offer_price: 900 } });
  assert.equal(r5.status, 400, 'offer above the stored price');

  // Hiding an item: it stays in the owner's list (In Active tab) but leaves the storefront.
  const hide = await h.request('PATCH', `${P}/products/${paint.body.data.uid}`, { token, body: { is_active: 0 } });
  assert.equal(hide.status, 200);
  let owner = await list();
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.body.meta.counts, { all: 2, products: 1, services: 1, inactive: 1 });
  assert.equal(owner.body.data.length, 2, 'owner sees active and inactive');
  assert.equal((await list('&is_active=0')).body.data.map((p) => p.name).join(), 'Wall Painting');
  assert.equal((await list('&type=product')).body.data.map((p) => p.name).join(), 'Red Velvet Cake');
  assert.deepEqual((await list('&type=product')).body.meta.counts.all, 2, 'counts ignore the filter');
  assert.equal((await list('&type=bogus')).status, 400);
  let store = await pub();
  assert.equal(store.status, 200);
  assert.deepEqual(store.body.data.map((p) => p.name), ['Red Velvet Cake'], 'public list is active-only');
  assert.equal((await pub('?type=service')).body.data.length, 0);

  // Re-enable, then flip the service to a product: the service_area is dropped.
  await h.request('PATCH', `${P}/products/${paint.body.data.uid}`, { token, body: { is_active: 1 } });
  const flipped = await h.request('PATCH', `${P}/products/${paint.body.data.uid}`, { token, body: { type: 'product', unit: 'per room' } });
  assert.equal(flipped.status, 200, JSON.stringify(flipped.body));
  assert.equal(flipped.body.data.type, 'product');
  assert.equal(flipped.body.data.service_area, null, 'stale service_area cleared on type change');
  assert.equal(flipped.body.data.unit, 'per room');
  assert.deepEqual((await pub('?type=product')).body.data.length, 2);

  // Deleting is distinct from hiding: gone from every owner list, not just the storefront.
  assert.equal((await h.request('DELETE', `${P}/products/${cake.body.data.uid}`, { token })).status, 200);
  owner = await list();
  assert.deepEqual(owner.body.meta.counts, { all: 1, products: 1, services: 0, inactive: 0 });
  assert.equal((await list('&is_active=0')).body.data.length, 0, 'a deleted item is not "inactive"');
  assert.equal((await h.request('GET', `${P}/products/${cake.body.data.uid}`, { token })).status, 404);
  store = await pub();
  assert.deepEqual(store.body.data.map((p) => p.name), ['Wall Painting'], 'public list drops the deleted item too');
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

  // An unknown ref is an empty picker, not a 404: the user was just made to pick an
  // industry, and answering "not found" about their own choice reads as a bug.
  const unknown = await h.request('GET', `${P}/industries/no-such-industry/keywords`);
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body.data, []);
});

test('industry keywords: a pending "Others" sub-industry falls back to its parent keywords', async () => {
  const stamp = Date.now() + 12;
  const { parent, child, tags } = await mkKeywordFixture(stamp);
  const u     = await mkUser('PendingKw');
  const token = h.userTokenFor(u.id);

  // The "Others" path: the owner types a sub-industry that is not in the catalogue.
  // It lands as status='pending', is_active=0 — and is immediately their industry.
  const customName = `TST Pending Kw ${stamp}`;
  const created = await h.request('POST', `${P}/businesses`, {
    token, body: { name: `TST Pending Biz ${stamp}`, industry: parent.slug, custom_sub_industry: customName },
  });
  assert.equal(created.status, 201);

  const suggested = await models.BusinessCategory.findOne({ where: { name: customName } });
  track.businessCategories.push(suggested.id);
  assert.equal(suggested.status, 'pending');
  assert.equal(suggested.is_active, 0);
  assert.equal(suggested.parent_id, parent.id);

  // The picker must answer for it — with the parent's keywords, since a fresh
  // suggestion has none of its own.
  const r = await h.request('GET', `${P}/industries/${suggested.slug}/keywords`);
  assert.equal(r.status, 200, 'a pending industry is not a 404 here');
  assert.deepEqual(r.body.data.map((t) => t.name), [tags[2].name], 'inherits the parent keyword');

  // Sanity: the same row is still hidden from the catalogue reads that DO gate.
  assert.equal((await h.request('GET', `${P}/industries/${suggested.slug}`)).status, 404, 'no public landing page');
  const list = await h.request('GET', `${P}/industries?parent=${parent.slug}`);
  assert.ok(!list.body.data.some((c) => c.id === suggested.id), 'not listed in the catalogue');

  // A retired parent must not empty the picker of a business already attached below it.
  await models.BusinessCategory.update({ is_active: 0 }, { where: { id: parent.id } });
  const afterRetire = await h.request('GET', `${P}/industries/${child.slug}/keywords`);
  assert.equal(afterRetire.body.data.length, 3, 'still own 2 + inherited 1');
  await models.BusinessCategory.update({ is_active: 1 }, { where: { id: parent.id } });
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

test('owner business reads expand BusinessCategory.parent', async () => {
  const stamp = Date.now() + 11;
  const { parent, child } = await mkKeywordFixture(stamp);
  const u     = await mkUser('ParentExp');
  const token = h.userTokenFor(u.id);

  const created = await h.request('POST', `${P}/businesses`, {
    token, body: { name: `TST Parent Exp ${stamp}`, industry: parent.slug, sub_industry: child.slug },
  });
  assert.equal(created.status, 201);

  // Every owner-facing read shares one include, so create and list must agree.
  for (const [label, cat] of [
    ['create', created.body.data.BusinessCategory],
    ['list',   (await h.request('GET', `${P}/businesses`, { token })).body.data[0].BusinessCategory],
    ['get',    (await h.request('GET', `${P}/businesses/${created.body.data.uid}`, { token })).body.data.BusinessCategory],
  ]) {
    assert.equal(cat.id, child.id, `${label}: attached to the leaf industry`);
    assert.ok(cat.parent, `${label}: parent expanded`);
    assert.equal(cat.parent.id, parent.id, `${label}: parent id`);
    assert.equal(cat.parent.slug, parent.slug, `${label}: parent slug`);
    assert.equal(cat.parent.name, parent.name, `${label}: parent name`);
  }

  // A top-level pick has no parent — the row must still come back, not be dropped
  // by the join.
  const u2  = await mkUser('ParentExpTop');
  const top = await h.request('POST', `${P}/businesses`, {
    token: h.userTokenFor(u2.id), body: { name: `TST Parent Top ${stamp}`, industry: parent.slug },
  });
  assert.equal(top.status, 201);
  assert.equal(top.body.data.BusinessCategory.id, parent.id, 'attached to the top-level industry');
  assert.equal(top.body.data.BusinessCategory.parent, null, 'top-level industry has parent: null');
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

// One business per account, so an owner who already finished signup can only reach
// "Others" by editing — the same path the Postman collection and the playground use,
// since a second POST /businesses is a 409 for them.
test('custom sub-industry can also be filed from PATCH /businesses/{uid}', async () => {
  const stamp    = Date.now() + 5;
  const { parent } = await mkKeywordFixture(stamp);
  const owner    = await mkUser('SugPatch');
  const token    = h.userTokenFor(owner.id);
  const customName = `TST Patched Kitchen ${stamp}`;

  const created = await h.request('POST', `${P}/businesses`, {
    token, body: { name: `TST Sug Patch Biz ${stamp}`, industry: parent.slug },
  });
  assert.equal(created.status, 201);
  const uid = created.body.data.uid;

  const patched = await h.request('PATCH', `${P}/businesses/${uid}`, {
    token, body: { industry: parent.slug, custom_sub_industry: customName },
  });
  assert.equal(patched.status, 200);

  const suggested = await models.BusinessCategory.findOne({ where: { name: customName } });
  track.businessCategories.push(suggested.id);
  assert.equal(suggested.status, 'pending');
  assert.equal(suggested.parent_id, parent.id);
  assert.equal(suggested.suggested_by_user_id, owner.id);
  assert.equal(patched.body.data.category_id, suggested.id, 'the business moves onto the suggestion');

  // Still mutually exclusive on the update schema, not just on create.
  const both = await h.request('PATCH', `${P}/businesses/${uid}`, {
    token, body: { industry: parent.slug, sub_industry: parent.slug, custom_sub_industry: 'TST Nope' },
  });
  assert.equal(both.status, 400);
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

test('a user cannot save an s3_key that was not issued to them (logo, product image, photo)', async () => {
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

  const { key, status } = await uploadOf(token, 'media_library', 2 * MB);
  assert.equal(status, 200);
  assert.equal(await storageUsed(userId), 2 * MB, 'charged to the bytes column, not a phantom storage_count');

  const ledger = await models.UserUpload.findOne({ where: { s3_key: key } });
  assert.equal(Number(ledger.bytes), 2 * MB);
  assert.equal(ledger.slot, 'media_library');

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

  const { key } = await uploadOf(token, 'media_library', 3 * MB);
  assert.equal(await storageUsed(userId), 3 * MB);

  const ledger = await models.UserUpload.findOne({ where: { s3_key: key } });

  await withStubbedS3(async (calls) => {
    const del = await h.request('DELETE', `${P}/uploads/${ledger.uid}`, { token });
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
    const ok = await uploadOf(token, 'media_library', 4 * MB);
    assert.equal(ok.status, 200);
    assert.equal(await storageUsed(userId), 4 * MB);

    // 4 MB + 2 MB > 5 MB â€” refused, and the object is removed rather than left
    // behind active (it would never be swept: the lifecycle rule only sees pending).
    await withStubbedS3(async (calls) => {
      const key = (await h.request('POST', `${P}/uploads/presign`, {
        token, body: { target: { slot: 'media_library' }, filename: 'big.png' },
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
        token, body: { target: { slot: 'media_library' }, filename: 'x.png' },
      });
      assert.equal(r.status, 402);
    });
  });
});

test('GET /subscriptions/me reports storage in MB, with exact bytes alongside', async () => {
  const userId = await userWithActivePlan(1, 9105);          // Free: 100 MB
  const token  = h.userTokenFor(userId);
  await uploadOf(token, 'media_library', Math.round(2.5 * MB));

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

  const ok = await uploadOf(token, 'media_library', 9 * MB);
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
  const user = await userByPhone(phone);
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
  const user   = await userByPhone(phone);
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
  const user  = await userByPhone(phone);
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
  const user  = await userByPhone(phone);
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
  const user  = await userByPhone(phone);
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
  const user  = await userByPhone(phone);
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
  const user  = await userByPhone(phone);
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
  const user = await userByPhone(phone);
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
  const user = await userByPhone(phone);
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
  const user = await userByPhone(phone);
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
  const user = await userByPhone(phone);
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

// ---------- Account purge (self-deactivation → deletion after the grace period) ----------

const purgeSvc = require('../src/services/accountPurge.service');

// Razorpay and S3 are stubbed the same way the upload tests stub S3: swap the
// functions on the module object and record the calls.
const withStubbedPurgeDeps = async (fn, { razorpayFails = false } = {}) => {
  const s3  = require('../src/utils/s3Helper');
  const rzp = require('../src/utils/razorpayHelper');
  const original = { deleteByPrefix: s3.deleteByPrefix, cancelSubscription: rzp.cancelSubscription };
  const calls = { prefixes: [], cancelled: [] };
  s3.deleteByPrefix      = async (prefix) => { calls.prefixes.push(prefix); };
  rzp.cancelSubscription = async (id) => {
    if (razorpayFails) throw new Error('gateway timeout');
    calls.cancelled.push(id);
  };
  try { return await fn(calls); } finally { Object.assign(s3, original); Object.assign(rzp, original); }
};

const setGraceHours = (hours) => models.AppSetting.update({ value: String(hours) }, { where: { key: purgeSvc.GRACE_SETTING_KEY } });
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3);

test('self-deactivation starts the deletion clock; admin deactivation does not', async () => {
  const phone = newPhone();
  const t     = await otpLogin(phone);
  const user  = await userByPhone(phone);
  track.users.push(user.id);

  const before = Date.now();
  const off    = await h.request('POST', `${P}/users/me/deactivate`, { token: t.access_token });
  assert.equal(off.status, 200);
  await user.reload();
  assert.ok(user.deactivated_at, 'stamped');

  const scheduled = new Date(off.body.data.deletion_scheduled_at).getTime();
  const expected  = new Date(user.deactivated_at).getTime() + 24 * 3600e3;
  assert.ok(Math.abs(scheduled - expected) < 5000, 'deletion_scheduled_at = deactivated_at + the 24h default');
  assert.ok(scheduled > before, 'in the future');

  // Admin reactivation cancels it.
  const admin = h.adminToken(['users.*']);
  const on = await h.request('PATCH', `${P}/admin/users/${user.uid}/status`, { token: admin, body: { is_active: 1 } });
  assert.equal(on.status, 200);
  await user.reload();
  assert.equal(user.is_active, 1);
  assert.equal(user.deactivated_at, null, 'clock cleared');

  // Admin deactivation is moderation: no clock.
  const ban = await h.request('PATCH', `${P}/admin/users/${user.uid}/status`, { token: admin, body: { is_active: 0 } });
  assert.equal(ban.status, 200);
  await user.reload();
  assert.equal(user.is_active, 0);
  assert.equal(user.deactivated_at, null, 'an admin ban never schedules a purge');
});

test('the purge job wipes everything a due account owns and leaves a tombstone', async () => {
  const phone = newPhone();
  const t     = await otpLogin(phone);
  const user  = await userByPhone(phone);
  track.users.push(user.id);

  // Real content via the API, plus rows in the tables the API is awkward to reach.
  const biz = (await h.request('POST', `${P}/businesses`, {
    token: t.access_token,
    body: { name: `TST Purge Biz ${Date.now()}`, industry: 'restaurant-food' },
  })).body.data;
  assert.ok(biz?.uid, 'business created');
  await h.request('PATCH', `${P}/users/me/preferences`, { token: t.access_token, body: { notify_email: false } });
  await models.UserUpload.create({ uid: uuid(), user_id: user.id, s3_key: `users/${user.uid}/logo/${uuid()}.png`, slot: 'logo', bytes: 100 });
  await models.Project.create({ uid: uuid(), user_id: user.id, name: 'TST Purge Project' });
  await models.UserBillingDetail.create({ user_id: user.id, billing_name: 'X', billing_address: 'Y', billing_state: 'KA', billing_pincode: '560001' });
  const pro = await models.Plan.findOne({ where: { name: 'Pro' } });
  const sub = await UserSubscription.create({
    uid: uuid(), user_id: user.id, plan_id: pro.id, sub_type: 'regular', status: 'active', auto_renew: 1,
    razorpay_subscription_id: `sub_TST${Date.now()}`,
    starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 299,
  });
  const sessionsBefore = await UserSession.count({ where: { actor_type: 'user', actor_id: user.id } });
  assert.ok(sessionsBefore > 0);

  // Deactivated 25 hours ago → due under the 24h default.
  await h.request('POST', `${P}/users/me/deactivate`, { token: t.access_token });
  await user.update({ deactivated_at: hoursAgo(25) });

  const result = await withStubbedPurgeDeps(async (calls) => {
    const r = await purgeSvc.runOnce();
    // `includes`, not deepEqual: the test DB persists, so a due account left by an
    // interrupted earlier run may legitimately be swept in the same pass.
    assert.equal(calls.prefixes.filter((p) => p === `users/${user.uid}/`).length, 1, 'the whole S3 namespace, once');
    assert.ok(calls.cancelled.includes(sub.razorpay_subscription_id), 'the recurring mandate is stopped');
    return r;
  });
  assert.ok(result.purged >= 1 && result.failed === 0, JSON.stringify(result));

  // Content: gone.
  assert.equal(await Business.count({ where: { user_id: user.id } }), 0);
  assert.equal(await models.Project.count({ where: { user_id: user.id } }), 0);
  assert.equal(await models.UserUpload.count({ where: { user_id: user.id } }), 0);
  assert.equal(await models.UserPreference.count({ where: { user_id: user.id } }), 0);
  assert.equal(await models.UserBillingDetail.count({ where: { user_id: user.id } }), 0, 'no invoices → billing details go too');
  assert.equal(await UserSession.count({ where: { actor_type: 'user', actor_id: user.id } }), 0);
  assert.equal(await OtpCode.count({ where: { phone: toE164(phone) } }), 0);

  // History: kept, but not live.
  await sub.reload();
  assert.equal(sub.status, 'cancelled');

  // Tombstone.
  await user.reload();
  assert.equal(user.name, 'Deleted User');
  assert.equal(user.phone, null);
  assert.equal(user.is_active, 0);
  assert.ok(user.purged_at);
  assert.ok(await ActivityLog.findOne({ where: { action: 'account_purged', entity_type: 'user', entity_id: user.id } }));

  // The number is free again: logging in with it makes a brand-new account.
  const again = await otpLogin(phone);
  const fresh = await userByPhone(phone);
  track.users.push(fresh.id);
  assert.notEqual(fresh.id, user.id, 'new account, not the tombstone');
  assert.equal((await h.request('GET', `${P}/users/me`, { token: again.access_token })).status, 200);

  // And the tombstone cannot be switched back on.
  const on = await h.request('PATCH', `${P}/admin/users/${user.uid}/status`, { token: h.adminToken(['users.*']), body: { is_active: 1 } });
  assert.equal(on.status, 409);
});

test('purge respects the grace period, the admin setting, and admin reactivation', async () => {
  const mk = async (deactivatedHoursAgo) => {
    const u = await mkUser('PurgeGrace');
    await u.update({ is_active: 0, deactivated_at: hoursAgo(deactivatedHoursAgo) });
    return u;
  };
  const recent    = await mk(2);      // inside 24h
  const old       = await mk(30);     // outside
  const rescued   = await mk(30);     // outside, but an admin brought them back
  const adminBan  = await mkUser('PurgeBan');
  await adminBan.update({ is_active: 0 });   // no deactivated_at: admin moderation

  await h.request('PATCH', `${P}/admin/users/${rescued.uid}/status`, { token: h.adminToken(['users.*']), body: { is_active: 1 } });

  const dueIds = (await purgeSvc.findDue()).map((u) => u.id);
  assert.ok(dueIds.includes(old.id),       'past the grace period → due');
  assert.ok(!dueIds.includes(recent.id),   'inside the grace period → not yet');
  assert.ok(!dueIds.includes(rescued.id),  'reactivated → cancelled');
  assert.ok(!dueIds.includes(adminBan.id), 'admin-deactivated → never');

  // Shorten the grace period from the admin setting: takes effect on the next scan.
  await setGraceHours(1);
  try {
    const shortened = (await purgeSvc.findDue()).map((u) => u.id);
    assert.ok(shortened.includes(recent.id), '2h-old deactivation is due under a 1h grace');
  } finally {
    await setGraceHours(24);
  }
  assert.equal(await purgeSvc.graceHours(), 24, 'restored');
});

test('a purge that cannot stop Razorpay billing leaves the account untouched for retry', async () => {
  const u = await mkUser('PurgeRzp');
  const pro = await models.Plan.findOne({ where: { name: 'Pro' } });
  await UserSubscription.create({
    uid: uuid(), user_id: u.id, plan_id: pro.id, sub_type: 'regular', status: 'active', auto_renew: 1,
    razorpay_subscription_id: `sub_TSTFAIL${Date.now()}`,
    starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 299,
  });
  await models.Project.create({ uid: uuid(), user_id: u.id, name: 'TST Survives' });
  await u.update({ is_active: 0, deactivated_at: hoursAgo(48) });

  await withStubbedPurgeDeps(async (calls) => {
    await assert.rejects(purgeSvc.purgeUser(u), /Razorpay cancel failed/);
    assert.equal(calls.prefixes.length, 0, 'S3 not touched');
  }, { razorpayFails: true });

  await u.reload();
  assert.equal(u.purged_at, null, 'still pending');
  assert.equal(u.name, 'TST PurgeRzp', 'nothing scrubbed');
  assert.equal(await models.Project.count({ where: { user_id: u.id } }), 1, 'content intact');
  assert.ok((await purgeSvc.findDue()).some((d) => d.id === u.id), 'will be retried next run');
});

// ---------- Project thumbnails (inline on the autosave call) ----------

// Smallest valid files of each type; what matters is the signature bytes.
const PNG_1PX  = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG_MIN = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 0), Buffer.from([0xff, 0xd9])]);
const dataUrl  = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;

const withStubbedThumbS3 = async (fn) => {
  const s3 = require('../src/utils/s3Helper');
  const original = { uploadFile: s3.uploadFile, deleteFile: s3.deleteFile };
  const calls = { uploaded: [], deleted: [] };
  s3.uploadFile = async (key, buf, type) => { calls.uploaded.push({ key, bytes: buf.length, type }); };
  s3.deleteFile = async (key) => { calls.deleted.push(key); };
  try { return await fn(calls); } finally { Object.assign(s3, original); }
};

test('project autosave: content and thumbnail in one PATCH, content-addressed, old preview cleaned up', async () => {
  const u     = await mkUser('Thumb');
  const token = h.userTokenFor(u.id);

  await withStubbedThumbS3(async (calls) => {
    // Create with a thumbnail straight away — the first save is one call too.
    const created = await h.request('POST', `${P}/projects`, { token, body: { name: 'TST Thumb', content: '{"v":1}', thumbnail: dataUrl(PNG_1PX) } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const proj = created.body.data;
    assert.match(proj.thumbnail_s3_key, new RegExp(`^users/${u.uid}/projects/${proj.uid}/thumb-[0-9a-f]{12}\\.png$`));
    assert.equal(calls.uploaded.length, 1);
    assert.equal(calls.uploaded[0].type, 'image/png', 'type comes from the bytes');
    assert.equal(await models.UserUpload.count({ where: { user_id: u.id } }), 0, 'not in the uploads ledger');

    // Same image again: no upload, same key.
    const same = await h.request('PATCH', `${P}/projects/${proj.uid}`, { token, body: { content: '{"v":2}', thumbnail: dataUrl(PNG_1PX) } });
    assert.equal(same.status, 200);
    assert.equal(same.body.data.thumbnail_s3_key, proj.thumbnail_s3_key, 'unchanged bytes → unchanged key');
    assert.equal(same.body.data.content, '{"v":2}', 'content still saved');
    assert.equal(calls.uploaded.length, 1, 'no second upload');

    // Different image: new key, old object deleted. Declared MIME is ignored.
    const next = await h.request('PATCH', `${P}/projects/${proj.uid}`, { token, body: { thumbnail: dataUrl(JPEG_MIN, 'image/png') } });
    assert.equal(next.status, 200);
    assert.match(next.body.data.thumbnail_s3_key, /\.jpg$/, 'sniffed as JPEG despite the data-URL saying png');
    assert.notEqual(next.body.data.thumbnail_s3_key, proj.thumbnail_s3_key);
    assert.deepEqual(calls.deleted, [proj.thumbnail_s3_key], 'previous preview removed');

    // Content-only PATCH leaves the thumbnail alone.
    const contentOnly = await h.request('PATCH', `${P}/projects/${proj.uid}`, { token, body: { content: '{"v":3}' } });
    assert.equal(contentOnly.body.data.thumbnail_s3_key, next.body.data.thumbnail_s3_key);
    assert.equal(calls.uploaded.length, 2);
  });
});

test('project thumbnail: rejects non-images and oversize, and a bad thumbnail saves nothing', async () => {
  const u     = await mkUser('ThumbBad');
  const token = h.userTokenFor(u.id);
  const proj  = (await h.request('POST', `${P}/projects`, { token, body: { name: 'TST ThumbBad', content: '{"v":1}' } })).body.data;

  await withStubbedThumbS3(async (calls) => {
    const attempt = (thumbnail, content = '{"v":"MUST_NOT_SAVE"}') =>
      h.request('PATCH', `${P}/projects/${proj.uid}`, { token, body: { content, thumbnail } });

    assert.equal((await attempt('data:image/png;base64,aGVsbG8gd29ybGQ=')).status, 400, 'text pretending to be png');
    assert.equal((await attempt('<svg xmlns="http://www.w3.org/2000/svg"/>')).status, 400, 'not base64 image bytes');
    assert.equal((await attempt('')).status, 400, 'empty');

    // Just over the cap, with a valid PNG header so only the size trips it.
    const { MAX_BYTES } = require('../src/services/projectThumbnail.service');
    const big = Buffer.concat([PNG_1PX, Buffer.alloc(MAX_BYTES - PNG_1PX.length + 1)]);
    const over = await attempt(dataUrl(big));
    assert.equal(over.status, 400);
    assert.match(JSON.stringify(over.body), /500 KB/);

    // Exactly at the cap is fine.
    const atCap = Buffer.concat([PNG_1PX, Buffer.alloc(MAX_BYTES - PNG_1PX.length)]);
    assert.equal((await attempt(dataUrl(atCap), '{"v":"changed"}')).status, 200);

    assert.equal(calls.uploaded.length, 1, 'only the valid one reached S3');
  });

  // The failed attempts did not save their content either.
  const row = await models.Project.findOne({ where: { uid: proj.uid } });
  assert.equal(row.content, '{"v":"changed"}', 'from the at-cap success only');
  assert.ok(row.thumbnail_s3_key);
});

test('billing details survive the purge when invoices exist', async () => {
  const u = await mkUser('PurgeInvoice');
  await models.UserBillingDetail.create({ user_id: u.id, billing_name: 'Invoiced Co', billing_address: 'Y', billing_state: 'KA', billing_pincode: '560001' });
  await Payment.create({ uid: uuid(), user_id: u.id, order_type: 'subscription', purchase_type: 'subscription', amount: 118, amount_before_tax: 100, gst_amount: 18, status: 'success', paid_at: new Date() });
  await u.update({ is_active: 0, deactivated_at: hoursAgo(48) });

  await withStubbedPurgeDeps(() => purgeSvc.purgeUser(u));

  assert.equal(await Payment.count({ where: { user_id: u.id } }), 1, 'the invoice is a tax record');
  assert.equal(await models.UserBillingDetail.count({ where: { user_id: u.id } }), 1, 'and the details it was issued to stay with it');
  await u.reload();
  assert.equal(u.name, 'Deleted User');
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
  const user = await userByPhone(phone);
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
        { target: { type: 'image_slot', slot: 'asset_thumbnail' },    filename: 'star-preview.png' },
      ] },
    });
    assert.equal(r.status, 200);

    const [banner, icon, badge, thumb] = r.body.data.files;
    assert.ok(banner.key.startsWith('banners/') && banner.key.endsWith('.png'));
    assert.ok(icon.key.startsWith('assets/icon/'), 'targets may be mixed within a batch');
    assert.ok(badge.key.startsWith('variants/badge-icon/'));
    // The preview is kept out of the asset_type folders the deliverables live in,
    // since it is the one asset file served to people who have not paid.
    assert.ok(thumb.key.startsWith('assets/thumbnail/'), 'asset thumbnails get their own prefix');
    assert.equal(new Set(r.body.data.files.map((f) => f.key)).size, 4);
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

// ---------- Frames: the store, ownership and purchase ----------
// Razorpay has no test double, so order creation is swapped out. Everything after
// the order — the pending row, the webhook, the grant — is the real code path.
const withStubbedRazorpay = async (fn) => {
  const rzp      = require('../src/utils/razorpayHelper');
  const original = rzp.createOrder;
  const calls    = [];
  rzp.createOrder = async (amount, currency, receipt) => {
    calls.push({ amount, currency, receipt });
    return { id: `order_frame_${calls.length}_${Date.now()}` };
  };
  try { return await fn(calls); } finally { rzp.createOrder = original; }
};

let frameSeq = 0;
const mkFrameCategory = async (over = {}) => {
  const stamp = `${Date.now()}${frameSeq++}`;
  const c = await models.FrameCategory.create({
    uid: uuid(), name: `TST Frame Cat ${stamp}`, slug: `tst-frame-cat-${stamp}`, ...over,
  });
  track.frameCategories.push(c.id);
  return c;
};

// A publishable frame by default — the gate is exercised explicitly below.
const mkFrame = async (over = {}) => {
  const stamp = `${Date.now()}${frameSeq++}`;
  const f = await models.Frame.create({
    uid: uuid(), name: `TST Frame ${stamp}`, content: '{"layers":[]}',
    thumbnail_s3_key: 'frames/thumbnail/x.png', status: 'active', ...over,
  });
  track.frames.push(f.id);
  return f;
};

test('the frames store lists active frames by tab and category, without the design payload', async () => {
  const branding    = await mkFrameCategory();
  const promotional = await mkFrameCategory();

  const free     = await mkFrame({ category_id: branding.id, frame_type: 'static' });
  const animated = await mkFrame({ category_id: branding.id, frame_type: 'animated' });
  const other    = await mkFrame({ category_id: promotional.id, frame_type: 'static' });
  const draft    = await mkFrame({ category_id: branding.id, status: 'draft' });

  const all = await h.request('GET', `${P}/frames?category=${branding.slug}`);
  assert.equal(all.status, 200, 'the store is public — no anchor required, unlike templates');
  const ids = all.body.data.map((f) => f.id);
  assert.ok(ids.includes(free.id) && ids.includes(animated.id));
  assert.ok(!ids.includes(other.id), 'a different category is filtered out');
  assert.ok(!ids.includes(draft.id), 'drafts never reach the store');

  assert.equal(all.body.data.find((f) => f.id === free.id).content, undefined,
    'the design payload is never in a list response');

  const animatedTab = await h.request('GET', `${P}/frames?category=${branding.slug}&frame_type=animated`);
  assert.deepEqual(animatedTab.body.data.map((f) => f.id), [animated.id],
    'the two tabs are a filter, not two endpoints');

  // A category that does not resolve empties the shelf rather than widening it.
  const bogus = await h.request('GET', `${P}/frames?category=no-such-frame-category`);
  assert.deepEqual(bogus.body.data, []);

  const chips = await h.request('GET', `${P}/frames/categories`);
  assert.equal(chips.status, 200);
  const chipIds = chips.body.data.map((c) => c.id);
  assert.ok(chipIds.includes(branding.id) && chipIds.includes(promotional.id));
});

test('a free frame is added to My Frames, and only then is its content served', async () => {
  const cat   = await mkFrameCategory();
  const frame = await mkFrame({ category_id: cat.id });
  const u     = await mkUser('FrameFree');
  const token = h.userTokenFor(u.id);

  // A free frame is never `is_locked` — that flag means "costs money you have not
  // paid", the same as on a store card. But the payload still waits until it is on
  // the shelf, so "My Frames" stays an honest record rather than something the
  // editor bypasses. `owned`, not `is_locked`, is what governs content.
  const before = await h.request('GET', `${P}/frames/${frame.uid}`, { token });
  assert.equal(before.body.data.owned, false);
  assert.equal(before.body.data.is_locked, false, 'free frames are never locked, on a card or in detail');
  assert.equal(before.body.data.content, undefined, 'but the payload still needs an add');

  const added = await h.request('POST', `${P}/frames/${frame.uid}/add`, { token });
  assert.equal(added.status, 201);
  assert.equal(added.body.data.acquired_via, 'free');
  assert.equal(added.body.data.status, 'active');

  const after = await h.request('GET', `${P}/frames/${frame.uid}`, { token });
  assert.equal(after.body.data.owned, true);
  assert.equal(after.body.data.is_locked, false);
  assert.equal(after.body.data.content, '{"layers":[]}', 'the payload is released to an owner');

  const mine = await h.request('GET', `${P}/frames/mine`, { token });
  assert.deepEqual(mine.body.data.map((r) => r.Frame.uid), [frame.uid]);

  assert.equal((await h.request('POST', `${P}/frames/${frame.uid}/add`, { token })).status, 409, 'already owned');

  // The store marks it, so the grid needs no per-card request.
  const store = await h.request('GET', `${P}/frames?category=${cat.slug}`, { token });
  assert.equal(store.body.data.find((f) => f.id === frame.id).owned, true);

  assert.equal((await h.request('GET', `${P}/frames/mine`)).status, 401);
});

test('a premium frame cannot be added for free, and buying it grants it on payment', async () => {
  const cat   = await mkFrameCategory();
  const frame = await mkFrame({ category_id: cat.id, is_premium: 1, price: 30 });
  const u     = await mkUser('FramePaid');
  const token = h.userTokenFor(u.id);

  assert.equal((await h.request('POST', `${P}/frames/${frame.uid}/add`, { token })).status, 403,
    'the free path must not hand out a paid frame');

  // `is_locked` reads the same on the card and in detail, so one badge drives both.
  const card = (await h.request('GET', `${P}/frames?category=${cat.slug}`, { token }))
    .body.data.find((f) => f.id === frame.id);
  const detail = (await h.request('GET', `${P}/frames/${frame.uid}`, { token })).body.data;
  assert.equal(card.is_locked, true);
  assert.equal(detail.is_locked, true, 'a premium frame is locked in both shapes');
  assert.equal(detail.content, undefined);

  const order = await withStubbedRazorpay(async (calls) => {
    const r = await h.request('POST', `${P}/frames/${frame.uid}/purchase`, { token });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.type, 'one_time');
    // 30 + 18% GST. The stored price is pre-tax; the gateway is handed the total.
    assert.equal(r.body.data.amount, 35.4);
    assert.equal(calls[0].amount, 35.4, 'the order is for the post-tax figure');
    return r.body.data;
  });

  // Owned only once payment confirms — until then it is pending and invisible.
  assert.deepEqual((await h.request('GET', `${P}/frames/mine`, { token })).body.data, []);
  const pending = await models.UserFrame.findOne({ where: { user_id: u.id, frame_id: frame.id } });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.acquired_via, 'purchase');

  const payment = await models.Payment.findOne({ where: { uid: order.payment_uid } });
  const evt = {
    event: 'payment.captured',
    payload: { payment: { entity: { id: `pay_frame_${u.id}`, order_id: payment.razorpay_order_id, amount: 3540 } } },
  };
  const { raw, sig } = signWebhook(evt);
  const hook = await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });
  assert.equal(hook.status, 200);

  const mine = await h.request('GET', `${P}/frames/mine`, { token });
  assert.deepEqual(mine.body.data.map((r) => r.Frame.uid), [frame.uid],
    'granted by the same webhook that activates a plan');
  assert.equal((await models.Payment.findOne({ where: { uid: order.payment_uid } })).status, 'success');

  // Replay changes nothing.
  const replay = await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });
  assert.equal(replay.body.idempotent, true);
  assert.equal((await h.request('GET', `${P}/frames/mine`, { token })).body.data.length, 1);

  assert.equal((await h.request('POST', `${P}/frames/${frame.uid}/purchase`, { token })).status, 409, 'no buying it twice');
});

test('a purchased frame that was removed comes back free', async () => {
  const cat   = await mkFrameCategory();
  const frame = await mkFrame({ category_id: cat.id, is_premium: 1, price: 100 });
  const u     = await mkUser('FrameRebuy');
  const token = h.userTokenFor(u.id);

  // Own it outright, the state the webhook would have left behind.
  const owned = await models.UserFrame.create({
    uid: uuid(), user_id: u.id, frame_id: frame.id, acquired_via: 'purchase',
    status: 'active', acquired_at: new Date(),
  });

  const removed = await h.request('DELETE', `${P}/frames/mine/${frame.uid}`, { token });
  assert.equal(removed.status, 200);
  assert.deepEqual((await h.request('GET', `${P}/frames/mine`, { token })).body.data, []);
  assert.equal((await models.UserFrame.findByPk(owned.id)).status, 'removed',
    'the record is kept — it is the proof they already paid');

  // Re-adding is free, through the same endpoint a free frame uses.
  const back = await h.request('POST', `${P}/frames/${frame.uid}/add`, { token });
  assert.equal(back.status, 201);
  assert.equal((await h.request('GET', `${P}/frames/mine`, { token })).body.data.length, 1);

  // And there is still nothing to charge for.
  await withStubbedRazorpay(async (calls) => {
    assert.equal((await h.request('POST', `${P}/frames/${frame.uid}/purchase`, { token })).status, 409);
    assert.deepEqual(calls, [], 'no order is created for a frame already owned');
  });

  const stranger = await mkUser('FrameStranger');
  assert.equal((await h.request('DELETE', `${P}/frames/mine/${frame.uid}`, { token: h.userTokenFor(stranger.id) })).status, 404,
    'someone else cannot remove it');
});

test('a business can only apply a frame from its owner shelf', async () => {
  const cat     = await mkFrameCategory();
  const mine    = await mkFrame({ category_id: cat.id });
  const unowned = await mkFrame({ category_id: cat.id, is_premium: 1, price: 50 });
  const u       = await mkUser('FrameApply');
  const token   = h.userTokenFor(u.id);

  const biz = (await h.request('POST', `${P}/businesses`, {
    token, body: { name: `TST Frame Biz ${Date.now()}`, industry: 'restaurant-food' },
  })).body.data;

  // Not on the shelf yet — a crafted id must not mount a frame nobody paid for.
  assert.equal((await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token, body: { active_frame_id: unowned.id } })).status, 400);
  assert.equal((await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token, body: { active_frame_id: mine.id } })).status, 400,
    'owning nothing means applying nothing, even for a free frame');

  await h.request('POST', `${P}/frames/${mine.uid}/add`, { token });
  const applied = await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token, body: { active_frame_id: mine.id } });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.data.active_frame_id, mine.id);

  const cleared = await h.request('PATCH', `${P}/businesses/${biz.uid}`, { token, body: { active_frame_id: null } });
  assert.equal(cleared.body.data.active_frame_id, null, 'null takes the frame off');
});

test('the admin publish gate holds a frame back until it is complete and priced coherently', async () => {
  const token = h.adminToken();
  const cat   = await mkFrameCategory();
  const stamp = `${Date.now()}${frameSeq++}`;

  const created = await h.request('POST', `${P}/admin/frames`, { token, body: { name: `TST Gate Frame ${stamp}` } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.status, 'draft', 'a new frame is always a draft');
  track.frames.push(created.body.data.id);
  const uid = created.body.data.uid;

  const bare = await h.request('PATCH', `${P}/admin/frames/${uid}`, { token, body: { status: 'active' } });
  assert.equal(bare.status, 400);
  const fields = bare.body.error.details.map((d) => d.field);
  assert.ok(['category_id', 'content', 'thumbnail_s3_key'].every((f) => fields.includes(f)), fields.join(','));

  await h.request('PATCH', `${P}/admin/frames/${uid}`, {
    token, body: { category_id: cat.id, content: '{"layers":[]}', thumbnail_s3_key: 'frames/thumbnail/y.png' },
  });

  // Priced but not marked premium, and vice versa — both are refused, because the
  // free path skips checkout entirely and would give away a frame with a price.
  const priced = await h.request('PATCH', `${P}/admin/frames/${uid}`, { token, body: { status: 'active', price: 30 } });
  assert.equal(priced.status, 400);
  assert.ok(priced.body.error.details.some((d) => d.field === 'price'));

  const freePremium = await h.request('PATCH', `${P}/admin/frames/${uid}`, { token, body: { status: 'active', is_premium: 1 } });
  assert.equal(freePremium.status, 400, 'a premium frame priced at zero would be bought for nothing');

  const ok = await h.request('PATCH', `${P}/admin/frames/${uid}`, { token, body: { status: 'active', is_premium: 1, price: 30 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'active');

  // Frames are their own permission domain, separate from templates.
  assert.equal((await h.request('GET', `${P}/admin/frames`, { token: h.adminToken(['templates.*']) })).status, 403);
  assert.equal((await h.request('GET', `${P}/admin/frames`, { token: h.adminToken(['frames.*']) })).status, 200);
});

test('the retired user_frame upload slot is gone', async () => {
  const u     = await mkUser('FrameSlot');
  const token = h.userTokenFor(u.id);
  const r = await h.request('POST', `${P}/uploads/presign`, {
    token, body: { target: { slot: 'user_frame' }, filename: 'x.png' },
  });
  assert.equal(r.status, 400, 'frames are catalogue content now, not something a user uploads');
});

test('the admin frames list pages, searches and reports the publish checklist per row', async () => {
  const token = h.adminToken();
  const cat   = await mkFrameCategory();
  const tag   = `Pg${Date.now()}${frameSeq++}`;

  // Three publishable, one deliberately incomplete.
  const made = [];
  // Drafts, so publishing made[0] below actually exercises the gate rather than
  // hitting the already-active short circuit.
  for (let i = 0; i < 3; i++) made.push(await mkFrame({ category_id: cat.id, name: `TST ${tag} Frame ${i}`, display_order: i, status: 'draft' }));
  const incomplete = await mkFrame({ name: `TST ${tag} Incomplete`, content: null, thumbnail_s3_key: null, status: 'draft' });

  const all = await h.request('GET', `${P}/admin/frames?search=${tag}`, { token });
  assert.equal(all.status, 200);
  assert.equal(all.body.meta.total, 4, 'meta.total counts the whole match, not the page');
  assert.equal(all.body.data.length, 4);
  assert.equal(all.body.data[0].content, undefined, 'the heavy payload stays out of the list');
  assert.ok(all.body.data.some((f) => f.status === 'draft'), 'admin sees every status, unlike the store');

  const paged = await h.request('GET', `${P}/admin/frames?search=${tag}&limit=2&offset=0`, { token });
  assert.equal(paged.body.data.length, 2);
  assert.equal(paged.body.meta.total, 4, 'total is unaffected by the page window');
  const page2 = await h.request('GET', `${P}/admin/frames?search=${tag}&limit=2&offset=2`, { token });
  assert.equal(page2.body.data.length, 2);
  assert.deepEqual(
    [...new Set([...paged.body.data, ...page2.body.data].map((f) => f.id))].length, 4,
    'the two pages do not overlap',
  );

  // The checklist: exactly what the gate would reject, without fetching each row.
  const bad = all.body.data.find((f) => f.id === incomplete.id);
  assert.equal(bad.is_publishable, false);
  assert.equal(Number(bad.has_content), 0);
  assert.equal(Number(bad.has_thumbnail), 0);
  const badFields = bad.missing_for_publish.map((m) => m.field);
  assert.ok(['category_id', 'content', 'thumbnail_s3_key'].every((f) => badFields.includes(f)), badFields.join(','));

  const good = all.body.data.find((f) => f.id === made[0].id);
  assert.equal(good.is_publishable, true);
  assert.deepEqual(good.missing_for_publish, []);

  // The list agrees with the gate: what it calls publishable actually publishes.
  const published = await h.request('PATCH', `${P}/admin/frames/${made[0].uid}`, { token, body: { status: 'active' } });
  assert.equal(published.status, 200);
  const refused = await h.request('PATCH', `${P}/admin/frames/${incomplete.uid}`, { token, body: { status: 'active' } });
  assert.equal(refused.status, 400);
  assert.deepEqual(
    refused.body.error.details.map((d) => d.field).sort(),
    badFields.sort(),
    'the checklist and the gate are the same list, not two that can drift',
  );

  // Filters still narrow the paged list.
  const drafts = await h.request('GET', `${P}/admin/frames?search=${tag}&status=draft`, { token });
  assert.ok(drafts.body.data.every((f) => f.status === 'draft'));
  assert.equal((await h.request('GET', `${P}/admin/frames?search=${tag}&category_id=${cat.id}`, { token })).body.meta.total, 3);

  assert.equal((await h.request('GET', `${P}/admin/frames`, { token: h.adminToken(['templates.*']) })).status, 403);
});

test('publishing is a status flip, and unpublishing is always allowed', async () => {
  const token = h.adminToken();
  const cat   = await mkFrameCategory();
  const frame = await mkFrame({ category_id: cat.id, status: 'draft' });
  const u     = await mkUser('FramePublish');
  const userToken = h.userTokenFor(u.id);

  // A draft is invisible to the store and cannot even be fetched by uid.
  assert.equal((await h.request('GET', `${P}/frames/${frame.uid}`)).status, 404);
  assert.ok(!(await h.request('GET', `${P}/frames?category=${cat.slug}`)).body.data.some((f) => f.id === frame.id));

  await h.request('PATCH', `${P}/admin/frames/${frame.uid}`, { token, body: { status: 'active' } });
  assert.ok((await h.request('GET', `${P}/frames?category=${cat.slug}`)).body.data.some((f) => f.id === frame.id),
    'published frames, and only those, reach the store');

  // Someone adds it while it is live.
  assert.equal((await h.request('POST', `${P}/frames/${frame.uid}/add`, { token: userToken })).status, 201);

  // Unpublishing needs no checklist — it is never gated, even when the row would
  // now fail to publish. Clearing the category is exactly that case.
  const unpublished = await h.request('PATCH', `${P}/admin/frames/${frame.uid}`, { token, body: { status: 'inactive', category_id: null } });
  assert.equal(unpublished.status, 200);
  assert.equal(unpublished.body.data.status, 'inactive');
  assert.ok(!(await h.request('GET', `${P}/frames?category=${cat.slug}`)).body.data.some((f) => f.id === frame.id),
    'pulled from the store');

  // It stays with whoever already owns it — retiring a frame is not a clawback.
  const mine = await h.request('GET', `${P}/frames/mine`, { token: userToken });
  assert.deepEqual(mine.body.data.map((r) => r.Frame.uid), [frame.uid]);

  // And re-publishing runs the gate again on the now-incomplete row.
  const rePublish = await h.request('PATCH', `${P}/admin/frames/${frame.uid}`, { token, body: { status: 'active' } });
  assert.equal(rePublish.status, 400);
  assert.ok(rePublish.body.error.details.some((d) => d.field === 'category_id'));
});

test('frames reorder in one transaction, and the store honours the order', async () => {
  const token = h.adminToken();
  const cat   = await mkFrameCategory();
  const tag   = `Ord${Date.now()}${frameSeq++}`;
  const a = await mkFrame({ category_id: cat.id, name: `TST ${tag} A`, display_order: 0 });
  const b = await mkFrame({ category_id: cat.id, name: `TST ${tag} B`, display_order: 1 });
  const c = await mkFrame({ category_id: cat.id, name: `TST ${tag} C`, display_order: 2 });

  const storeOrder = async () => (await h.request('GET', `${P}/frames?category=${cat.slug}`)).body.data.map((f) => f.id);
  assert.deepEqual(await storeOrder(), [a.id, b.id, c.id]);

  const moved = await h.request('PATCH', `${P}/admin/frames/reorder`, { token, body: { ids: [c.uid, a.uid, b.uid] } });
  assert.equal(moved.status, 200);
  assert.deepEqual(await storeOrder(), [c.id, a.id, b.id], 'position in the array becomes display_order');

  // All-or-nothing: one unknown id changes nothing.
  const bad = await h.request('PATCH', `${P}/admin/frames/reorder`, { token, body: { ids: [a.uid, b.uid, uuid()] } });
  assert.equal(bad.status, 404);
  assert.deepEqual(await storeOrder(), [c.id, a.id, b.id], 'the failed batch left the order untouched');

  assert.equal((await h.request('PATCH', `${P}/admin/frames/reorder`, { token: h.adminToken(['frames.read']), body: { ids: [a.uid] } })).status, 403);
});

// ---------- Quota top-ups ----------
// The two shapes matter more than any single endpoint here: storage is a LEVEL a
// top-up raises the ceiling of, AI credits are a monthly TALLY where the plan
// allowance is spent first and only the overflow comes out of the purchased
// balance. Get that wrong in either direction and a reset either eats what
// someone paid for, or hands it back to them every month.
const quotaSvc = require('../src/services/quota.service');

let packSeq = 0;
const featureIdFor = async (key) => (await models.FeatureType.findOne({ where: { key } })).id;

// A publishable pack by default — the gate is exercised explicitly below.
const mkQuotaPack = async (over = {}) => {
  const stamp = `${Date.now()}${packSeq++}`;
  const p = await models.QuotaPack.create({
    uid: uuid(), name: `TST Pack ${stamp}`, feature_type_id: await featureIdFor('ai_credits'),
    quantity: 500, price: 99, status: 'active', ...over,
  });
  track.quotaPacks.push(p.id);
  return p;
};

// An active grant, the state a confirmed purchase leaves behind.
const mkGrant = async (userId, key, quantity, over = {}) => models.UserQuotaGrant.create({
  uid: uuid(), user_id: userId, feature_type_id: await featureIdFor(key),
  quantity, source: 'admin_grant', status: 'active', granted_at: new Date(), ...over,
});

// Temporarily narrow a plan's allowance for one feature, the way withStorageLimitMb
// does for storage. Restores whatever was there, including "no row at all".
const withPlanFeature = async (planId, key, value, fn) => {
  const featureTypeId = await featureIdFor(key);
  const existing = await models.PlanFeature.findOne({ where: { plan_id: planId, feature_type_id: featureTypeId } });
  const original = existing ? existing.value : null;
  if (existing) await existing.update({ value });
  else await models.PlanFeature.create({ plan_id: planId, feature_type_id: featureTypeId, value });

  try { return await fn(); } finally {
    if (original === null) await models.PlanFeature.destroy({ where: { plan_id: planId, feature_type_id: featureTypeId } });
    else await models.PlanFeature.update({ value: original }, { where: { plan_id: planId, feature_type_id: featureTypeId } });
  }
};

const creditsUsed = async (userId) => {
  const row = await models.UserQuotaUsage.findOne({ where: { user_id: userId } });
  return row ? Number(row.ai_credits_used) : 0;
};

test('MODE agrees with feature_types.reset_period for every metered feature', async () => {
  // The map is hardcoded because a column name cannot be read out of a row, so
  // this is what stops it drifting from the data it is meant to mirror. A feature
  // that resets is a tally (top-ups debit it); one that never resets is a level
  // (top-ups raise its ceiling).
  //
  // Checked over the keys the map declares, not over every row in the table: a
  // feature type invented at runtime has no counter column either, so it is not
  // metered at all and there is nothing for the map to be wrong about.
  for (const key of Object.keys(quotaSvc.MODE)) {
    const ft = await models.FeatureType.findOne({ where: { key } });
    assert.ok(ft, `${key} is in MODE but not in feature_types`);
    const expected = ft.reset_period === 'never' ? 'gauge' : 'flow';
    assert.equal(quotaSvc.MODE[key], expected,
      `${key} resets ${ft.reset_period}, so it must be a ${expected}`);
  }

  // And every counter the service knows how to write has to declare its shape,
  // or it would silently default to a tally and be zeroed every month.
  for (const key of Object.keys(quotaSvc.FIELD)) {
    assert.ok(quotaSvc.MODE[key], `${key} has a counter column but no MODE entry`);
  }
});

test('a storage top-up raises the ceiling, and freeing space returns the purchased headroom', async () => {
  const userId = await userWithActivePlan(1, 9301);
  const token  = h.userTokenFor(userId);

  await withStorageLimitMb(5, async () => {
    // 8 MB against a 5 MB plan: refused outright before any top-up exists.
    const refused = await uploadOf(token, 'media_library', 8 * MB);
    assert.equal(refused.status, 402, 'over the plan limit with nothing bought');
    assert.equal(await storageUsed(userId), 0);

    // Buy 10 MB. Storage is a LEVEL, so the grant simply lifts the ceiling to 15.
    await mkGrant(userId, 'storage', 10);

    const ok = await uploadOf(token, 'media_library', 8 * MB);
    assert.equal(ok.status, 200, 'the same file fits once the ceiling is raised');
    assert.equal(await storageUsed(userId), 8 * MB);

    // A gauge never debits its grant — the counter alone tracks occupancy.
    const grant = await models.UserQuotaGrant.findOne({ where: { user_id: userId } });
    assert.equal(Number(grant.consumed), 0, 'nothing is deducted from a storage grant');

    // 8 + 9 > 15 — still enforced, just against the higher ceiling.
    const over = await uploadOf(token, 'media_library', 9 * MB);
    assert.equal(over.status, 402, 'a top-up raises the ceiling, it does not remove it');

    // Deleting the file frees the purchased space again, which is the whole point
    // of buying capacity rather than a one-off allowance.
    const row = await models.UserUpload.findOne({ where: { s3_key: ok.key } });
    await withStubbedS3(async () => {
      await h.request('DELETE', `${P}/uploads/${row.uid}`, { token });
    });
    assert.equal(await storageUsed(userId), 0);
    assert.equal((await uploadOf(token, 'media_library', 9 * MB)).status, 200,
      'a file that did not fit a moment ago fits again — the purchased capacity came back');
  });
});

test('AI credits spend the plan allowance first, then the purchased balance', async () => {
  const userId = await userWithActivePlan(1, 9302);

  await withPlanFeature(1, 'ai_credits', 5, async () => {
    // Fill the plan allowance.
    await quotaSvc.consume(userId, 'ai_credits', 5, { source: 'image_generation' });
    assert.equal(await creditsUsed(userId), 5);

    // Nothing bought yet -> the wall is real.
    await assert.rejects(
      () => quotaSvc.assertWithinQuota(userId, 'ai_credits', 1),
      (err) => err.errorCode === 'QUOTA_EXCEEDED',
    );

    const grant = await mkGrant(userId, 'ai_credits', 10);

    // The 6th credit comes out of the grant, NOT the counter. That split is what
    // lets the counter be zeroed each cycle without giving back paid-for credits.
    await quotaSvc.consume(userId, 'ai_credits', 1, { source: 'background_removal' });
    assert.equal(await creditsUsed(userId), 5, 'the counter never exceeds the plan allowance');
    assert.equal(Number((await grant.reload()).consumed), 1, 'the overflow is debited from the grant');

    // Spanning the boundary in one call splits the same way.
    await quotaSvc.consume(userId, 'ai_credits', 9, { source: 'logo_generation' });
    assert.equal(Number((await grant.reload()).consumed), 10, 'grant fully spent');

    await assert.rejects(
      () => quotaSvc.assertWithinQuota(userId, 'ai_credits', 1),
      (err) => err.errorCode === 'QUOTA_EXCEEDED',
      'plan spent and balance spent — back to the wall',
    );
  });
});

test('a spend attributed to another feature tool is rejected as a wiring mistake', async () => {
  const userId = await userWithActivePlan(1, 9303);
  await assert.rejects(
    () => quotaSvc.consume(userId, 'downloads', 1, { source: 'image_generation' }),
    /belongs to/,
    'a bad source would make the breakdown lie, so it fails loudly rather than recording',
  );
});

test('the cycle reset zeroes the flow counters, and leaves levels and grants alone', async () => {
  const userId = await userWithActivePlan(1, 9304);

  await withPlanFeature(1, 'ai_credits', 5, async () => {
    await quotaSvc.consume(userId, 'ai_credits', 5, { source: 'image_generation' });
    const grant = await mkGrant(userId, 'ai_credits', 10);
    await quotaSvc.consume(userId, 'ai_credits', 3, { source: 'image_generation' });

    const row = await models.UserQuotaUsage.findOne({ where: { user_id: userId } });
    await row.update({
      storage_used_bytes: 4 * MB, template_views_count: 7,
      period_start: '2026-01-01', period_end: '2026-02-01',   // expired
    });

    const window = await quotaSvc.ensureCurrentPeriod(userId);
    assert.ok(window && new Date(window.end) > new Date(), 'rolled onto the current window');

    await row.reload();
    assert.equal(Number(row.ai_credits_used), 0, 'the monthly tally starts again');
    assert.equal(Number(row.storage_used_bytes), 4 * MB, 'storage is occupancy, not a tally — zeroing it would hand out free space');
    assert.equal(Number(row.template_views_count), 7, 'reset_period never — a lifetime total, not a cycle one');
    assert.equal(Number((await grant.reload()).consumed), 3, 'purchased credits stay spent across the boundary');
  });
});

test('the usage window is anchored to the subscription day-of-month, clamped at month ends', async () => {
  // 31 Jan + 1 month is 3 Mar to a raw setMonth, because February has no 31st.
  const feb = quotaSvc.addMonthsClamped(new Date(2026, 0, 31), 1);
  assert.equal(feb.getMonth(), 1, 'lands in February, not March');
  assert.equal(feb.getDate(), 28, '2026 is not a leap year');
  assert.equal(quotaSvc.addMonthsClamped(new Date(2024, 0, 31), 1).getDate(), 29, 'leap year keeps the 29th');
  assert.equal(quotaSvc.addMonthsClamped(new Date(2026, 2, 15), -1).getDate(), 15, 'negative months work the same way');

  const userId = await userWithActivePlan(1, 9305);
  const sub    = await UserSubscription.findOne({ where: { user_id: userId, status: 'active' } });
  await sub.update({ starts_at: new Date(2026, 0, 31) });

  const window = await quotaSvc.currentWindow(userId, new Date(2026, 1, 10));
  assert.equal(window.start, '2026-01-31');
  assert.equal(window.end, '2026-02-28', 'the reset date the app shows is a real calendar day');
});

test('an account with no subscription has no window to reset against', async () => {
  const u = await mkUser('NoCycle');
  await quotaSvc.consume(u.id, 'downloads', 1, { source: 'download' });
  // Usage is still RECORDED for the free tier — it just is not enforced, and
  // there is no anchor to compute an honest reset date from.
  assert.equal(await quotaSvc.ensureCurrentPeriod(u.id), null);
  const row = await models.UserQuotaUsage.findOne({ where: { user_id: u.id } });
  assert.equal(row.period_end, null);
  assert.equal(Number(row.downloads_count), 1);
});

test('the top-up store lists active packs for one feature with the tax-inclusive total', async () => {
  const pack  = await mkQuotaPack({ quantity: 500, price: 99, strike_price: 149, badge: 'Best value' });
  const draft = await mkQuotaPack({ status: 'draft' });
  const store = await mkQuotaPack({ feature_type_id: await featureIdFor('storage'), quantity: 1024, price: 49 });

  const r = await h.request('GET', `${P}/quota/packs?feature=ai_credits`);
  assert.equal(r.status, 200, 'the shelf is public — pricing is not a secret');
  const ids = r.body.data.map((p) => p.id);
  assert.ok(ids.includes(pack.id));
  assert.ok(!ids.includes(draft.id), 'drafts never reach the store');
  assert.ok(!ids.includes(store.id), 'filtered to the requested feature');

  const card = r.body.data.find((p) => p.id === pack.id);
  assert.equal(card.feature.key, 'ai_credits');
  assert.equal(card.feature.unit, 'count');
  // 99 + 18% GST. The stored price is pre-tax; the card shows what is charged.
  assert.equal(card.total_price, 116.82);
  assert.equal(card.gst_amount, 17.82);
  assert.equal(Number(card.strike_price), 149);

  const mb = await h.request('GET', `${P}/quota/packs?feature=storage`);
  assert.equal(mb.body.data.find((p) => p.id === store.id).feature.unit, 'MB',
    'quantity is in the feature own unit, so the card has to say which');

  const bogus = await h.request('GET', `${P}/quota/packs?feature=no-such-feature`);
  assert.deepEqual(bogus.body.data, [], 'an unknown key empties the shelf rather than widening it');
});

test('buying a top-up creates a pending grant, and the webhook activates it once', async () => {
  const userId = await userWithActivePlan(1, 9306);
  const token  = h.userTokenFor(userId);
  const pack   = await mkQuotaPack({ quantity: 500, price: 99 });

  const order = await withPlanFeature(1, 'ai_credits', 5, () => withStubbedRazorpay(async (calls) => {
    const r = await h.request('POST', `${P}/quota/packs/${pack.uid}/purchase`, { token });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.amount, 116.82);
    assert.equal(calls[0].amount, 116.82, 'the order is for the post-tax figure');
    return r.body.data;
  }));

  // Pending contributes nothing — an abandoned checkout must not credit anyone.
  let grant = await models.UserQuotaGrant.findOne({ where: { user_id: userId } });
  assert.equal(grant.status, 'pending');
  assert.equal(Number(grant.quantity), 500, 'snapshotted, so editing the pack later cannot change it');
  assert.equal((await quotaSvc.balanceFor(userId, 'ai_credits')).remaining, 0);

  const payment = await models.Payment.findOne({ where: { uid: order.payment_uid } });
  assert.equal(payment.purchase_type, 'quota_pack', 'fulfilment routes on this, not on the absence of a subscription');

  const evt = {
    event: 'payment.captured',
    payload: { payment: { entity: { id: `pay_quota_${userId}`, order_id: payment.razorpay_order_id, amount: 11682 } } },
  };
  const { raw, sig } = signWebhook(evt);
  assert.equal((await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } })).status, 200);

  grant = await grant.reload();
  assert.equal(grant.status, 'active');
  assert.equal((await quotaSvc.balanceFor(userId, 'ai_credits')).remaining, 500);

  // Replay changes nothing — the same guard that protects a plan activation.
  const replay = await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });
  assert.equal(replay.body.idempotent, true);
  assert.equal(await models.UserQuotaGrant.count({ where: { user_id: userId } }), 1);

  // Unlike a frame, the same pack can be bought again — this is a balance, not
  // an ownership record.
  await withPlanFeature(1, 'ai_credits', 5, () => withStubbedRazorpay(async () => {
    assert.equal((await h.request('POST', `${P}/quota/packs/${pack.uid}/purchase`, { token })).status, 201);
  }));
  assert.equal(await models.UserQuotaGrant.count({ where: { user_id: userId } }), 2);
});

test('a top-up that would buy nothing is refused rather than sold', async () => {
  const pack = await mkQuotaPack();

  // No subscription: the feature is not metered for this account at all, so extra
  // headroom would sit on top of nothing.
  const free = await mkUser('NoPlanTopup');
  const noPlan = await h.request('POST', `${P}/quota/packs/${pack.uid}/purchase`, { token: h.userTokenFor(free.id) });
  assert.equal(noPlan.status, 409);
  assert.match(noPlan.body.error.message, /paid plans/);

  // Subscribed, but the plan already grants the feature without limit (seeded Pro
  // is -1 for AI credits) — there is no ceiling to raise.
  const proId = await userWithActivePlan(2, 9307);
  const unlimited = await h.request('POST', `${P}/quota/packs/${pack.uid}/purchase`, { token: h.userTokenFor(proId, 'paid') });
  assert.equal(unlimited.status, 409);
  assert.match(unlimited.body.error.message, /unlimited/);

  assert.equal(await models.UserQuotaGrant.count({ where: { user_id: [free.id, proId] } }), 0, 'no grant, no order');
});

test('GET /quota/usage reports plan, top-up and the per-tool breakdown, agreeing with /subscriptions/me', async () => {
  const userId = await userWithActivePlan(1, 9308);
  const token  = h.userTokenFor(userId);

  await withPlanFeature(1, 'ai_credits', 1000, async () => {
    await mkGrant(userId, 'ai_credits', 200);
    await quotaSvc.consume(userId, 'ai_credits', 120, { source: 'image_generation' });
    await quotaSvc.consume(userId, 'ai_credits', 40,  { source: 'background_removal' });
    await quotaSvc.consume(userId, 'ai_credits', 35,  { source: 'logo_generation' });
    await quotaSvc.consume(userId, 'ai_credits', 80,  { source: 'text_to_audio' });

    const r = await h.request('GET', `${P}/quota/usage`, { token });
    assert.equal(r.status, 200);
    const credits = r.body.data.features.find((f) => f.key === 'ai_credits');

    assert.equal(credits.limit, 1000, 'limit stays the PLAN allowance — existing clients read it that way');
    assert.equal(credits.used, 275);
    assert.equal(credits.topup_granted, 200);
    assert.equal(credits.topup_remaining, 200, 'nothing has overflowed into it yet');
    assert.equal(credits.effective_limit, 1200);
    assert.equal(credits.remaining, 925, 'plan headroom plus the purchased balance');
    assert.equal(credits.topupable, true);

    const byTool = Object.fromEntries(credits.breakdown.map((b) => [b.source, b.used]));
    assert.deepEqual(byTool, { image_generation: 120, background_removal: 40, logo_generation: 35, text_to_audio: 80 });
    assert.equal(credits.breakdown.find((b) => b.source === 'image_generation').label, 'Image Generation');

    // The two endpoints share one builder precisely so this can never disagree:
    // the app gates on /subscriptions/me and renders the Usage screen from here.
    const me = await h.request('GET', `${P}/subscriptions/me`, { token });
    const mine = me.body.data.features.find((f) => f.key === 'ai_credits');
    for (const field of ['limit', 'used', 'remaining', 'topup_granted', 'topup_remaining', 'effective_limit']) {
      assert.equal(mine[field], credits[field], `${field} must match across both endpoints`);
    }
    assert.equal(mine.breakdown, undefined, 'the breakdown is extra detail, not carried by the polled endpoint');
    assert.equal(me.body.data.period.end, r.body.data.period.end);
  });
});

test('an admin can grant quota by hand and revoke it, and revoking never claws back what was spent', async () => {
  const userId = await userWithActivePlan(1, 9309);
  const user   = await User.findByPk(userId);
  const admin  = h.adminToken();

  const created = await h.request('POST', `${P}/admin/users/${user.uid}/quota-grants`, {
    token: admin, body: { feature: 'ai_credits', quantity: 50, note: 'Ticket 4821 — generation failed' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.source, 'admin_grant');
  assert.equal(created.body.data.status, 'active', 'no payment to wait for');
  assert.equal((await quotaSvc.balanceFor(userId, 'ai_credits')).remaining, 50);

  // A grant with no reason is indistinguishable from a mistake six months later.
  const noNote = await h.request('POST', `${P}/admin/users/${user.uid}/quota-grants`, {
    token: admin, body: { feature: 'ai_credits', quantity: 50 },
  });
  assert.equal(noNote.status, 400);

  const listed = await h.request('GET', `${P}/admin/users/${user.uid}/quota-grants`, { token: admin });
  assert.equal(listed.body.data.length, 1);

  await withPlanFeature(1, 'ai_credits', 0, async () => {
    await quotaSvc.consume(userId, 'ai_credits', 20, { source: 'image_generation' });
    assert.equal((await quotaSvc.balanceFor(userId, 'ai_credits')).remaining, 30);

    const revoked = await h.request('DELETE', `${P}/admin/quota-grants/${created.body.data.uid}`, { token: admin });
    assert.equal(revoked.status, 200);
    // The row survives as the audit record, and quantity and consumed leave the
    // balance together — so this is a withdrawal of what is left, not a clawback.
    const row = await models.UserQuotaGrant.findOne({ where: { uid: created.body.data.uid } });
    assert.equal(row.status, 'revoked');
    assert.equal(Number(row.consumed), 20, 'what was spent is still on the record');
    assert.equal((await quotaSvc.balanceFor(userId, 'ai_credits')).remaining, 0, 'floored, never negative');

    assert.equal((await h.request('DELETE', `${P}/admin/quota-grants/${created.body.data.uid}`, { token: admin })).status, 200,
      'revoking twice is idempotent');
  });
});

test('the pack publish gate refuses to sell quota that could never be spent', async () => {
  const admin  = h.adminToken();
  const aiId   = await featureIdFor('ai_credits');
  const viewId = await featureIdFor('template_views');   // seeded is_topupable = 0

  const create = async (body) => h.request('POST', `${P}/admin/quota-packs`, { token: admin, body });

  const draft = await create({ name: `TST Gate Pack ${Date.now()}`, feature_type_id: aiId, quantity: 0, price: 0 });
  assert.equal(draft.status, 201, 'an incomplete pack may exist as a draft');
  track.quotaPacks.push(draft.body.data.id);

  const noQuantity = await h.request('PATCH', `${P}/admin/quota-packs/${draft.body.data.uid}`, {
    token: admin, body: { status: 'active' },
  });
  assert.equal(noQuantity.status, 400);
  const fields = noQuantity.body.error.details.map((d) => d.field);
  assert.ok(fields.includes('quantity') && fields.includes('price'), 'the gate names every unmet requirement at once');

  // A pack for a feature nobody may top up is the failure worth guarding: it would
  // take money and grant a balance no meter will ever read.
  const notTopupable = await create({
    name: `TST Gate Pack B ${Date.now()}`, feature_type_id: viewId, quantity: 100, price: 10, status: 'active',
  });
  assert.equal(notTopupable.status, 400);
  assert.match(JSON.stringify(notTopupable.body.error.details), /not enabled for top-ups/);

  const ok = await h.request('PATCH', `${P}/admin/quota-packs/${draft.body.data.uid}`, {
    token: admin, body: { quantity: 500, price: 99, status: 'active' },
  });
  assert.equal(ok.status, 200, 'setting the missing fields and status together publishes in one call');

  // Unpublishing is never gated, and is not a clawback.
  assert.equal((await h.request('PATCH', `${P}/admin/quota-packs/${draft.body.data.uid}`, {
    token: admin, body: { status: 'inactive' },
  })).status, 200);
});

test('the admin pack list reports the same checklist the gate enforces, and needs its own permission', async () => {
  const pack = await mkQuotaPack({ status: 'draft', quantity: 0, price: 0 });

  const r = await h.request('GET', `${P}/admin/quota-packs`, { token: h.adminToken() });
  assert.equal(r.status, 200);
  const row = r.body.data.find((p) => p.id === pack.id);
  assert.equal(row.is_publishable, false);

  // The list and the gate come from one function, so a row the list calls
  // publishable can never be rejected by the gate.
  const gate = await h.request('PATCH', `${P}/admin/quota-packs/${pack.uid}`, {
    token: h.adminToken(), body: { status: 'active' },
  });
  assert.deepEqual(gate.body.error.details.map((d) => d.field), row.missing_for_publish.map((m) => m.field));

  // Commerce, not content: quota_packs sits with plans and coupons.
  assert.equal((await h.request('GET', `${P}/admin/quota-packs`, { token: h.adminToken(['templates.*']) })).status, 403);
  assert.equal((await h.request('GET', `${P}/admin/users/${uuid()}/quota-grants`, { token: h.adminToken(['frames.*']) })).status, 403);
});

test('a subscription.charged webhook records the renewal payment and extends the term', async () => {
  // Regression: _onSubCharged reads GST_RATE, which stopped being in scope when
  // the GST helper moved to utils/gst.js — so every recurring renewal threw a
  // ReferenceError before writing the payment or extending ends_at.
  const u = await mkUser('Renewal');
  const endsAt = new Date(Date.now() + 5 * 864e5);
  const sub = await UserSubscription.create({
    uid: uuid(), user_id: u.id, plan_id: 2, plan_billing_option_id: 1, sub_type: 'trial', status: 'active',
    starts_at: new Date(), ends_at: endsAt, auto_renew: 1, amount_paid: 352.82,
    razorpay_subscription_id: `sub_renew_${u.id}`,
  });

  const evt = {
    event: 'subscription.charged',
    payload: {
      subscription: { entity: { id: sub.razorpay_subscription_id } },
      payment:      { entity: { id: `pay_renew_${u.id}`, amount: 35282 } },
    },
  };
  const { raw, sig } = signWebhook(evt);
  const r = await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  const payment = await Payment.findOne({ where: { razorpay_payment_id: `pay_renew_${u.id}` } });
  assert.ok(payment, 'the renewal is recorded');
  assert.equal(Number(payment.amount), 352.82);
  assert.equal(Number(payment.amount_before_tax), 299, 'GST is backed out of the gross charge');
  assert.equal(payment.purchase_type, 'subscription');

  const after = await sub.reload();
  assert.equal(after.sub_type, 'regular', 'the first real charge converts a trial');
  assert.ok(new Date(after.ends_at) > endsAt, 'the term is extended from the old end date');

  const replay = await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });
  assert.equal(replay.body.idempotent, true);
});

// ---------- Billing & Payments: method capture, history, documents, cancel renewal ----------
const INVOICE_NO = /^MMB\/\d{4}-\d{2}\/\d{6}$/;

// A pending one-time plan purchase for `u`, the state the checkout leaves behind.
const mkPendingPlanPayment = async (u, over = {}) => {
  const sub = await UserSubscription.create({
    uid: uuid(), user_id: u.id, plan_id: 2, plan_billing_option_id: 1,
    status: 'pending', starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), auto_renew: 0, amount_paid: 352.82,
  });
  const payment = await Payment.create({
    uid: uuid(), user_id: u.id, subscription_id: sub.id, order_type: 'one_time', purchase_type: 'subscription',
    amount: 352.82, amount_before_tax: 299, gst_amount: 53.82, razorpay_order_id: `order_bill_${u.id}_${Date.now()}`, status: 'pending',
    ...over,
  });
  return { sub, payment };
};

const captured = (payment, entity) => signWebhook({
  event: 'payment.captured',
  payload: { payment: { entity: { id: `pay_bill_${payment.id}`, order_id: payment.razorpay_order_id, amount: 35282, ...entity } } },
});

test('the webhook records how a payment was paid and issues its invoice number once', async () => {
  const u = await mkUser('Method');
  const { payment } = await mkPendingPlanPayment(u);

  const { raw, sig } = captured(payment, { method: 'upi', vpa: 'pramod@okaxis' });
  assert.equal((await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } })).status, 200);

  const after = await payment.reload();
  assert.equal(after.status, 'success');
  assert.equal(after.payment_method, 'upi');
  assert.equal(after.payment_method_detail, 'UPI · pr***@okaxis', 'the VPA handle is masked, never stored whole');
  assert.match(after.invoice_number, INVOICE_NO);

  const first = after.invoice_number;
  await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });
  assert.equal((await payment.reload()).invoice_number, first, 'a redelivered webhook never renumbers');

  // A second payment draws the next number in the same financial year.
  const { payment: p2 } = await mkPendingPlanPayment(u);
  const w2 = captured(p2, { method: 'card', card: { network: 'Visa', last4: '4242' } });
  await h.request('POST', `${P}/subscriptions/webhook`, { body: w2.raw, headers: { 'x-razorpay-signature': w2.sig } });
  const second = (await p2.reload());
  assert.equal(second.payment_method_detail, 'VISA •• 4242');
  const seq = (n) => parseInt(n.split('/')[2], 10);
  assert.equal(seq(second.invoice_number), seq(first) + 1, 'numbers are sequential');
  assert.equal(second.invoice_number.split('/')[1], first.split('/')[1], 'same FY');
});

test('the client callback confirms without a method and the webhook fills it in afterwards', async () => {
  const u = await mkUser('Callback');
  const { payment } = await mkPendingPlanPayment(u);
  // Mark it the way verifyPayment does (signature-verified callback, no method).
  await payment.update({ status: 'success', razorpay_payment_id: `pay_cb_${payment.id}`, paid_at: new Date() });

  const { raw, sig } = captured(payment, { method: 'netbanking', bank: 'HDFC' });
  const r = await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });
  assert.equal(r.body.idempotent, true, 'already paid — nothing is fulfilled twice');
  const after = await payment.reload();
  assert.equal(after.payment_method, 'netbanking');
  assert.equal(after.payment_method_detail, 'Netbanking · HDFC');
});

test('a recurring charge records its method and Razorpay invoice id', async () => {
  const u = await mkUser('RenewMethod');
  const sub = await UserSubscription.create({
    uid: uuid(), user_id: u.id, plan_id: 2, plan_billing_option_id: 1, sub_type: 'regular', status: 'active',
    starts_at: new Date(), ends_at: new Date(Date.now() + 5 * 864e5), auto_renew: 1, amount_paid: 352.82,
    razorpay_subscription_id: `sub_method_${u.id}`,
  });
  const { raw, sig } = signWebhook({
    event: 'subscription.charged',
    payload: {
      subscription: { entity: { id: sub.razorpay_subscription_id } },
      payment:      { entity: { id: `pay_rm_${u.id}`, amount: 35282, method: 'upi', vpa: 'someone@ybl', invoice_id: `inv_${u.id}` } },
    },
  });
  await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });

  const payment = await Payment.findOne({ where: { razorpay_payment_id: `pay_rm_${u.id}` } });
  assert.equal(payment.payment_method, 'upi');
  assert.equal(payment.razorpay_invoice_id, `inv_${u.id}`);
  assert.match(payment.invoice_number, INVOICE_NO);

  // And the subscription card reports the method of its latest charge.
  const me = await h.request('GET', `${P}/subscriptions/me`, { token: h.userTokenFor(u.id) });
  assert.equal(me.body.data.subscription.payment_gateway, 'razorpay');
  assert.equal(me.body.data.subscription.payment_method, 'upi');
  assert.equal(me.body.data.subscription.payment_method_detail, 'UPI · so***@ybl');
  assert.equal(me.body.data.subscription.cancel_renewal_allowed, true);
  // The charge extended the term; renews_on is the NEW end.
  assert.equal(new Date(me.body.data.subscription.renews_on).getTime(), new Date((await sub.reload()).ends_at).getTime());
});

test('payment history describes each purchase and exposes documents for successful rows only', async () => {
  const u     = await mkUser('History');
  const token = h.userTokenFor(u.id);

  const { payment: paid }   = await mkPendingPlanPayment(u);
  const { raw, sig }        = captured(paid, { method: 'upi', vpa: 'h@okicici' });
  await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });
  const { payment: failed } = await mkPendingPlanPayment(u, { status: 'failed', failure_reason: 'declined' });
  const { payment: pend }   = await mkPendingPlanPayment(u);

  const r = await h.request('GET', `${P}/subscriptions/payments`, { token });
  assert.equal(r.status, 200);
  const rows = r.body.data.items;
  assert.equal(rows.length, 3, 'pending and failed attempts are listed too');
  assert.deepEqual(rows.map((x) => x.uid), [pend.uid, failed.uid, paid.uid], 'newest first');
  assert.equal(r.body.data.last_transaction.uid, paid.uid, 'the newest SUCCESSFUL row, not the newest attempt');
  assert.equal(r.body.data.pagination.total, 3);

  const paidRow = rows.find((x) => x.uid === paid.uid);
  assert.match(paidRow.description, /Monthly Plan$/);
  assert.equal(paidRow.payment_method, 'upi');
  assert.equal(paidRow.documents_available, true);
  assert.match(paidRow.invoice_number, INVOICE_NO);
  assert.equal(rows.find((x) => x.uid === failed.uid).documents_available, false);
  assert.equal(rows.find((x) => x.uid === pend.uid).documents_available, false);

  // Invoice: HTML, the number, the GST breakup and the buyer's saved billing block.
  await h.request('PUT', `${P}/users/me/billing`, { token, body: {
    billing_name: 'Acme Studio', gstin: '29ABCDE1234F1Z5', billing_address: '1 MG Road', billing_state: 'Karnataka', billing_pincode: '560001',
  } });
  const inv = await h.request('GET', `${P}/subscriptions/payments/${paid.uid}/document?type=invoice`, { token });
  assert.equal(inv.status, 200);
  assert.match(inv.headers['content-type'], /text\/html/);
  assert.ok(inv.body.includes('Tax Invoice'));
  assert.ok(inv.body.includes(paidRow.invoice_number));
  assert.ok(inv.body.includes('Acme Studio') && inv.body.includes('29ABCDE1234F1Z5'), 'buyer block from PUT /users/me/billing');
  assert.ok(inv.body.includes('299.00') && inv.body.includes('352.82'), 'taxable value and total');
  assert.ok(inv.body.includes('IGST @ 18%') || inv.body.includes('CGST @ 9%'), 'GST split rendered');

  const rec = await h.request('GET', `${P}/subscriptions/payments/${paid.uid}/document?type=receipt`, { token });
  assert.equal(rec.status, 200);
  assert.ok(rec.body.includes('Payment Receipt') && rec.body.includes(`pay_bill_${paid.id}`), 'receipt carries the gateway reference');

  assert.equal((await h.request('GET', `${P}/subscriptions/payments/${paid.uid}/document?type=pdf`, { token })).status, 400);
  assert.equal((await h.request('GET', `${P}/subscriptions/payments/${pend.uid}/document`, { token })).status, 409, 'no document for money not received');
  const other = await mkUser('Other');
  assert.equal((await h.request('GET', `${P}/subscriptions/payments/${paid.uid}/document`, { token: h.userTokenFor(other.id) })).status, 403);
  assert.equal((await h.request('GET', `${P}/subscriptions/payments/${uuid()}/document`, { token })).status, 404);
});

test('a payment that succeeded before numbering existed is numbered on first document request', async () => {
  const u = await mkUser('Backfill');
  const { payment } = await mkPendingPlanPayment(u, {
    status: 'success', razorpay_payment_id: `pay_old_${Date.now()}`, paid_at: new Date('2025-06-15T10:00:00Z'),
  });
  assert.equal(payment.invoice_number, null);

  const r = await h.request('GET', `${P}/subscriptions/payments/${payment.uid}/document`, { token: h.userTokenFor(u.id) });
  assert.equal(r.status, 200);
  const numbered = (await payment.reload()).invoice_number;
  assert.match(numbered, INVOICE_NO);
  assert.equal(numbered.split('/')[1], '2025-26', 'dated to when it was paid, not when it was viewed');
  assert.ok(r.body.includes(numbered));
});

test('escapes user-authored text in the documents', async () => {
  const u = await mkUser('Xss');
  const { payment } = await mkPendingPlanPayment(u, { status: 'success', razorpay_payment_id: `pay_x_${Date.now()}`, paid_at: new Date() });
  const token = h.userTokenFor(u.id);
  await h.request('PUT', `${P}/users/me/billing`, { token, body: {
    billing_name: '<script>alert(1)</script>', billing_address: 'x', billing_state: 'Kerala', billing_pincode: '682001',
  } });
  const r = await h.request('GET', `${P}/subscriptions/payments/${payment.uid}/document`, { token });
  assert.ok(!r.body.includes('<script>'), 'raw tag never reaches the page');
  assert.ok(r.body.includes('&lt;script&gt;'));
});

// The gateway has no test double: the cancel call is swapped out and recorded.
const withStubbedCancel = async (fn, { fail } = {}) => {
  const rzp      = require('../src/utils/razorpayHelper');
  const original = rzp.cancelSubscriptionAtCycleEnd;
  const calls    = [];
  rzp.cancelSubscriptionAtCycleEnd = async (id) => {
    calls.push(id);
    if (fail) { const e = new Error('gateway'); e.error = { description: fail }; throw e; }
    return { id, status: 'active', has_scheduled_changes: true };
  };
  try { return await fn(calls); } finally { rzp.cancelSubscriptionAtCycleEnd = original; }
};

test('cancel renewal stops the mandate at cycle end and leaves the paid term intact', async () => {
  const u      = await mkUser('Cancel');
  const token  = h.userTokenFor(u.id);
  // Whole seconds: DATETIME drops the milliseconds and the round-trip must match.
  const endsAt = new Date(Math.floor((Date.now() + 20 * 864e5) / 1000) * 1000);
  const sub    = await UserSubscription.create({
    uid: uuid(), user_id: u.id, plan_id: 2, plan_billing_option_id: 1, sub_type: 'regular', status: 'active',
    starts_at: new Date(), ends_at: endsAt, auto_renew: 1, amount_paid: 352.82, razorpay_subscription_id: `sub_cancel_${u.id}`,
  });

  await withStubbedCancel(async (calls) => {
    const r = await h.request('POST', `${P}/subscriptions/me/cancel-renewal`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(calls, [sub.razorpay_subscription_id], 'cancelled at the gateway, at cycle end');
    assert.equal(r.body.data.auto_renew, false);
    assert.equal(r.body.data.can_resume, false);
    assert.equal(new Date(r.body.data.access_until).getTime(), endsAt.getTime());

    const after = await sub.reload();
    assert.equal(after.status, 'active', 'still entitled until the term ends');
    assert.equal(Number(after.auto_renew), 0);
    assert.ok(after.cancelled_at);

    const me = await h.request('GET', `${P}/subscriptions/me`, { token });
    assert.equal(me.body.data.has_active_subscription, true);
    assert.equal(me.body.data.subscription.auto_renew, false);
    assert.equal(me.body.data.subscription.renews_on, null);
    assert.equal(me.body.data.subscription.cancel_renewal_allowed, false);
    assert.ok(me.body.data.subscription.renewal_cancelled_at);

    const again = await h.request('POST', `${P}/subscriptions/me/cancel-renewal`, { token });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.idempotent, true, 'a second click is a no-op');
    assert.equal(calls.length, 1, 'the gateway is not called again');

    // The user is told, once, with the plan and the date access ends.
    const note = await models.UserNotification.findOne({ where: { user_id: u.id, dedupe_key: `renewal_cancelled:sub:${sub.id}` } });
    assert.ok(note, 'renewal_cancelled notification is posted');
    assert.equal(note.status, 'delivered', 'transactional — not held for quiet hours');
    assert.ok(note.body.includes('will not renew'));
    assert.ok(note.body.includes(endsAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })));
    assert.equal(await models.UserNotification.count({ where: { user_id: u.id, dedupe_key: `renewal_cancelled:sub:${sub.id}` } }), 1);
  });

  // Razorpay closes the mandate at cycle end; the user's cancellation date stands.
  const stamped = (await sub.reload()).cancelled_at;
  const { raw, sig } = signWebhook({ event: 'subscription.cancelled', payload: { subscription: { entity: { id: sub.razorpay_subscription_id } } } });
  await h.request('POST', `${P}/subscriptions/webhook`, { body: raw, headers: { 'x-razorpay-signature': sig } });
  const ended = await sub.reload();
  assert.equal(ended.status, 'cancelled');
  assert.equal(new Date(ended.cancelled_at).getTime(), new Date(stamped).getTime(), 'the webhook does not move cancelled_at');
});

test('cancel renewal refuses what cannot renew and does not lie when the gateway fails', async () => {
  const u     = await mkUser('CancelNo');
  const token = h.userTokenFor(u.id);
  assert.equal((await h.request('POST', `${P}/subscriptions/me/cancel-renewal`, { token })).status, 404, 'nothing active');

  const oneTime = await UserSubscription.create({
    uid: uuid(), user_id: u.id, plan_id: 2, plan_billing_option_id: 1, status: 'active',
    starts_at: new Date(), ends_at: new Date(Date.now() + 864e5), auto_renew: 0, amount_paid: 352.82,
  });
  assert.equal((await h.request('POST', `${P}/subscriptions/me/cancel-renewal`, { token })).status, 409, 'a one-time plan has no renewal');
  await oneTime.update({ status: 'expired' });

  const recurring = await UserSubscription.create({
    uid: uuid(), user_id: u.id, plan_id: 2, plan_billing_option_id: 1, status: 'active',
    starts_at: new Date(), ends_at: new Date(Date.now() + 864e5), auto_renew: 1, amount_paid: 352.82, razorpay_subscription_id: `sub_fail_${u.id}`,
  });
  await withStubbedCancel(async () => {
    const r = await h.request('POST', `${P}/subscriptions/me/cancel-renewal`, { token });
    assert.equal(r.status, 502);
    assert.equal(Number((await recurring.reload()).auto_renew), 1, 'the row is untouched while the mandate is still live');
  }, { fail: 'Razorpay is down' });

  // "Already cancelled" at the gateway means renewal HAS stopped — record it.
  await withStubbedCancel(async () => {
    const r = await h.request('POST', `${P}/subscriptions/me/cancel-renewal`, { token });
    assert.equal(r.status, 200);
    assert.equal(Number((await recurring.reload()).auto_renew), 0);
  }, { fail: 'Subscription is already cancelled' });
});

// ---------- Relaxed quota enforcement ----------
// A suspended limit has to be suspended EVERYWHERE at once — the upload gate, the
// numbers the app renders, and the top-up store — or the user gets a red bar and a
// Buy button for a limit nothing is applying. All of it derives from limitFor,
// which is the only place the switch is read.
const withRelaxed = async (features, fn) => {
  const original = process.env.QUOTA_RELAXED_FEATURES;
  process.env.QUOTA_RELAXED_FEATURES = features;
  try { return await fn(); } finally {
    if (original === undefined) delete process.env.QUOTA_RELAXED_FEATURES;
    else process.env.QUOTA_RELAXED_FEATURES = original;
  }
};

test('relaxing storage stops enforcement but keeps recording usage', async () => {
  const userId = await userWithActivePlan(1, 9401);
  const token  = h.userTokenFor(userId);

  await withStorageLimitMb(5, async () => {
    // Baseline: enforced, so this is refused.
    assert.equal((await uploadOf(token, 'media_library', 8 * MB)).status, 402);

    await withRelaxed('storage', async () => {
      const ok = await uploadOf(token, 'media_library', 8 * MB);
      assert.equal(ok.status, 200, 'the limit is not applied while relaxed');

      // The important half: the counter and the ledger keep running, so turning
      // enforcement back on needs no backfill.
      assert.equal(await storageUsed(userId), 8 * MB, 'usage is still recorded');
      assert.ok(await models.UserUpload.findOne({ where: { s3_key: ok.key } }), 'still on the ledger');

      // Reported the way the account is actually treated — no red bar, no
      // remaining figure the server would not honour.
      const q = await h.request('GET', `${P}/uploads/quota`, { token });
      assert.equal(q.body.data.unlimited, true);
      assert.equal(q.body.data.limit_bytes, null);
      assert.equal(q.body.data.remaining_bytes, null);
      assert.equal(q.body.data.used_bytes, 8 * MB, 'the real figure is still reported');
      assert.equal(q.body.data.max_upload_bytes, 10 * MB, 'the per-FILE cap is a separate guard and stays on');

      const me = (await h.request('GET', `${P}/subscriptions/me`, { token })).body.data;
      const storage = me.features.find((f) => f.key === 'storage');
      assert.equal(storage.unlimited, true);
      assert.equal(storage.limit, null);
      assert.equal(storage.remaining, null);
      assert.equal(storage.enforced, false, 'the plan still says 100 MB — this says it is not being applied');
      assert.equal(storage.topupable, false, 'nothing to top up, so no Buy button');

      // Other features are untouched by a storage relaxation.
      const credits = me.features.find((f) => f.key === 'ai_credits');
      assert.equal(credits.enforced, undefined, 'only relaxed features carry the flag');
    });

    // Restored the moment the switch goes off — and it enforces against the usage
    // that accumulated while relaxed, which is why recording mattered. The account
    // is now over its limit, so presign refuses before the client uploads anything
    // (uploadOf can't be used here: it assumes presign hands back a key).
    const blocked = await withStubbedS3(() => h.request('POST', `${P}/uploads/presign`, {
      token, body: { target: { slot: 'media_library' }, filename: 'x.png' },
    }));
    assert.equal(blocked.status, 402, 'already over the 5 MB limit from the relaxed period');

    const restored = await h.request('GET', `${P}/uploads/quota`, { token });
    assert.equal(restored.body.data.unlimited, false);
    assert.equal(restored.body.data.remaining_bytes, 0, 'floored, not negative, despite being over');
  });
});

test('a top-up for a relaxed feature is refused, and says why honestly', async () => {
  const userId = await userWithActivePlan(1, 9402);
  const token  = h.userTokenFor(userId);
  const pack   = await mkQuotaPack({
    feature_type_id: await featureIdFor('storage'), quantity: 1024, price: 49,
  });

  await withRelaxed('storage', async () => {
    const r = await h.request('POST', `${P}/quota/packs/${pack.uid}/purchase`, { token });
    assert.equal(r.status, 409);
    // Not "your plan already includes unlimited storage" — the plan says 100 MB.
    assert.match(r.body.error.message, /not currently limited/);
    assert.equal(await models.UserQuotaGrant.count({ where: { user_id: userId } }), 0);
  });

  // Balances bought BEFORE the relaxation are untouched by it — grants never
  // expire, so they are simply idle until enforcement returns.
  const grant = await mkGrant(userId, 'storage', 500);
  await withRelaxed('storage', async () => {
    assert.equal((await quotaSvc.balanceFor(userId, 'storage')).remaining, 500 * MB);
  });
  assert.equal(Number((await grant.reload()).consumed), 0);
});

// ---------- Notifications ----------
//
// The properties worth defending here are the ones whose failure is SILENT: a
// dedupe key that stops re-firing (users quietly never hear from us again), one
// that fires every night (spam), a consent check a promo can slip past, and a
// system template whose code an admin can rename out from under the code that
// dispatches it.

const notifySvc     = require('../src/services/notification.service');
const notifyScans   = require('../src/services/notificationScans.service');
const dedupeKey     = require('../src/utils/dedupeKey');
const notifyCleanup = require('../src/jobs/notificationCleanup.job');

// Fatigue rules are stateful and per-user, so anything asserting a specific SKIP
// reason needs a user no earlier test has already notified.
let notifSeq = 0;
async function makeNotifUser(overrides = {}) {
  const u = await User.create({
    name: `TST notif ${Date.now()}-${notifSeq}`,
    phone: `${6 + (notifSeq % 4)}${String(Date.now()).slice(-7)}${notifSeq % 10}`,
    account_type: 'personal',
    ...overrides,
  });
  notifSeq += 1;
  track.users.push(u.id);
  return u;
}

async function makeNotifTemplate(overrides = {}) {
  notifSeq += 1;
  const cat = await models.NotificationCategory.create({
    name: `TST cat ${Date.now()}-${notifSeq}`, slug: `tst-cat-${Date.now()}-${notifSeq}`,
  });
  track.notificationCategories.push(cat.id);

  const tpl = await models.NotificationTemplate.create({
    code: `tst_${Date.now()}_${notifSeq}`,
    category_id: cat.id,
    title: 'Test notification',
    body: 'Body text.',
    trigger_type: 'event',
    is_promotional: 0,
    ...overrides,
  });
  track.notificationTemplates.push(tpl.id);
  return { tpl, cat };
}

test('the seeded notification catalogue is complete and every template can render', async () => {
  const rows = await models.NotificationTemplate.findAll({ where: { is_system: 1 } });
  assert.ok(rows.length >= 40, `expected the seeded catalogue, got ${rows.length}`);

  // Declared variables must match the copy in both directions. Drift here ships a
  // literal "{{credits_count}}" to real users.
  const { assertVariableContract } = require('../src/utils/renderTemplate');
  for (const t of rows) {
    assert.doesNotThrow(
      () => assertVariableContract({ title: t.title, body: t.body, variables: t.variables || [] }),
      `template '${t.code}' has a broken variable contract`,
    );
  }

  // A behavioural template naming a predicate nothing implements is a permanent
  // silent no-op — the exact failure this feature must not have.
  for (const t of rows.filter((r) => r.trigger_type === 'behavioral' && r.is_active)) {
    assert.ok(notifyScans.PREDICATES[(t.trigger_config || {}).predicate],
      `behavioural template '${t.code}' names an unimplemented predicate`);
  }
});

test('a dedupe key identifies the occasion, so one event never notifies twice', async () => {
  const user = await makeNotifUser();
  const { tpl } = await makeNotifTemplate();

  const first  = await notifySvc.dispatch({ code: tpl.code, userId: user.id, dedupeKey: dedupeKey.forEntity(tpl.code, 'pay', 1) });
  const second = await notifySvc.dispatch({ code: tpl.code, userId: user.id, dedupeKey: dedupeKey.forEntity(tpl.code, 'pay', 1) });
  const other  = await notifySvc.dispatch({ code: tpl.code, userId: user.id, dedupeKey: dedupeKey.forEntity(tpl.code, 'pay', 2) });

  assert.ok(first.created);
  assert.equal(second.created, null);
  assert.equal(second.skipped, 'duplicate');
  assert.ok(other.created, 'a different occasion must send again');
  assert.equal(await models.UserNotification.count({ where: { user_id: user.id } }), 2);
});

test('a bulk dispatch is idempotent, which is what makes the scan jobs safe to re-run', async () => {
  const a = await makeNotifUser();
  const b = await makeNotifUser();
  const { tpl } = await makeNotifTemplate();
  const key = dedupeKey.forCampaign(987654);

  const run1 = await notifySvc.dispatchBulk({ code: tpl.code, userIds: [a.id, b.id], dedupeKey: key });
  const run2 = await notifySvc.dispatchBulk({ code: tpl.code, userIds: [a.id, b.id], dedupeKey: key });

  assert.equal(run1.inserted, 2);
  assert.equal(run2.inserted, 0);
  assert.equal(run2.reasons.duplicate, 2);
  assert.equal(await models.UserNotification.count({ where: { dedupe_key: key } }), 2);
});

test('a dormancy key repeats for the same lapse and changes for a new one', async () => {
  const day = 86400000;
  const lapsedOn = new Date(Date.now() - 8 * day);

  assert.equal(
    dedupeKey.forDormancy('inactive_7d', lapsedOn),
    dedupeKey.forDormancy('inactive_7d', lapsedOn),
    're-scanning an unchanged last_active_at must produce the same key',
  );
  assert.notEqual(
    dedupeKey.forDormancy('inactive_7d', new Date(Date.now() - 7 * day)),
    dedupeKey.forDormancy('inactive_7d', lapsedOn),
    'a user who returned and lapsed again must get a new key',
  );
});

test('marketing consent stops a promo but never a receipt', async () => {
  const user = await makeNotifUser();
  await models.UserPreference.create({ user_id: user.id, notify_marketing: 0 });

  const { tpl: promo }   = await makeNotifTemplate({ is_promotional: 1 });
  const { tpl: receipt } = await makeNotifTemplate({ is_promotional: 0 });

  const p = await notifySvc.dispatch({ code: promo.code, userId: user.id, dedupeKey: 'p:1' });
  const r = await notifySvc.dispatch({ code: receipt.code, userId: user.id, dedupeKey: 'r:1' });

  assert.equal(p.skipped, 'marketing_opt_out');
  assert.ok(r.created, 'a transactional notification must ignore marketing consent');
});

test('muting a category stops everything in it, transactional included', async () => {
  const user = await makeNotifUser();
  const { tpl, cat } = await makeNotifTemplate({ is_promotional: 0 });
  await models.UserNotificationSetting.create({ user_id: user.id, category_id: cat.id, in_app: 0 });

  const res = await notifySvc.dispatch({ code: tpl.code, userId: user.id, dedupeKey: 'm:1' });
  assert.equal(res.skipped, 'category_muted');
});

test('audience targeting keeps a personal-only notification away from a business account', async () => {
  const personal = await makeNotifUser({ account_type: 'personal' });
  const business = await makeNotifUser({ account_type: 'business' });
  const { tpl } = await makeNotifTemplate({ audience_account_type: 'personal' });

  assert.ok((await notifySvc.dispatch({ code: tpl.code, userId: personal.id, dedupeKey: 'a:1' })).created);
  assert.equal(
    (await notifySvc.dispatch({ code: tpl.code, userId: business.id, dedupeKey: 'a:1' })).skipped,
    'audience_mismatch',
  );
});

test('a missing variable aborts the send rather than shipping a hole', async () => {
  const user = await makeNotifUser();
  const { tpl } = await makeNotifTemplate({
    title: 'Low', body: 'Only {{credits_count}} left.', variables: ['credits_count'],
  });

  const res = await notifySvc.dispatch({ code: tpl.code, userId: user.id, variables: {}, dedupeKey: 'v:1' });
  assert.equal(res.skipped, 'render_failed');
  assert.equal(await models.UserNotification.count({ where: { user_id: user.id } }), 0);
});

test('the inbox lists, reads and dismisses, and hides expired and quiet-held rows', async () => {
  const user  = await makeNotifUser();
  const token = h.userTokenFor(user.id);
  const { tpl } = await makeNotifTemplate();

  await notifySvc.dispatch({ code: tpl.code, userId: user.id, dedupeKey: 'i:1' });
  await notifySvc.dispatch({ code: tpl.code, userId: user.id, dedupeKey: 'i:2' });

  // Neither of these may ever be visible.
  await models.UserNotification.create({
    user_id: user.id, dedupe_key: 'i:expired', title: 'Expired', body: 'x',
    status: 'delivered', deliver_at: new Date(Date.now() - 86400000),
    expires_at: new Date(Date.now() - 3600000),
  });
  await models.UserNotification.create({
    user_id: user.id, dedupe_key: 'i:held', title: 'Held', body: 'x',
    status: 'scheduled', deliver_at: new Date(Date.now() + 86400000),
  });

  const list = await h.request('GET', `${P}/notifications`, { token });
  assert.equal(list.status, 200);
  assert.equal(list.body.meta.total, 2, 'expired and quiet-hours-held rows must not be listed');
  assert.ok(!('user_id' in list.body.data[0]), 'internal ids must not leak to the client');

  assert.equal((await h.request('GET', `${P}/notifications/summary`, { token })).body.data.unread_count, 2);

  const target = list.body.data[0].uid;
  assert.equal((await h.request('PATCH', `${P}/notifications/${target}/read`, { token })).status, 200);
  assert.equal((await h.request('GET', `${P}/notifications/summary`, { token })).body.data.unread_count, 1);

  assert.equal((await h.request('PATCH', `${P}/notifications/${target}/dismiss`, { token })).status, 200);
  assert.equal((await h.request('GET', `${P}/notifications`, { token })).body.meta.total, 1);
  // Dismiss is soft: the row still counts toward throttling and answers "did we tell them?".
  assert.equal(await models.UserNotification.count({ where: { user_id: user.id } }), 4);
});

test('another user notification is a 404, not a cross-account write', async () => {
  const owner = await makeNotifUser();
  const nosy  = await makeNotifUser();
  const { tpl } = await makeNotifTemplate();

  const created = await notifySvc.dispatch({ code: tpl.code, userId: owner.id, dedupeKey: 'x:1' });
  const r = await h.request('PATCH', `${P}/notifications/${created.created.uid}/read`, {
    token: h.userTokenFor(nosy.id),
  });
  assert.equal(r.status, 404);
});

test('notification settings default to on and can mute a category', async () => {
  const user  = await makeNotifUser();
  const token = h.userTokenFor(user.id);

  const before = await h.request('GET', `${P}/notifications/settings`, { token });
  assert.equal(before.status, 200);
  assert.ok(before.body.data.every((c) => c.in_app === true), 'untouched categories default to on');

  const target = before.body.data[0];
  const after = await h.request('PUT', `${P}/notifications/settings`, {
    token, body: { settings: [{ category_uid: target.uid, in_app: false }] },
  });
  assert.equal(after.status, 200);
  assert.equal(after.body.data.find((c) => c.uid === target.uid).in_app, false);

  const bad = await h.request('PUT', `${P}/notifications/settings`, {
    token, body: { settings: [{ category_uid: 'nope', in_app: false }] },
  });
  assert.equal(bad.status, 400);
});

test('admin notification templates: system rows stay editable but their identity is locked', async () => {
  const token = h.adminToken(['*']);
  const seeded = await models.NotificationTemplate.findOne({ where: { code: 'payment_failed' } });
  assert.ok(seeded, 'the seeded catalogue must be present');

  const renamed = await h.request('PATCH', `${P}/admin/notification-templates/${seeded.uid}`, {
    token, body: { code: 'payment_failed_v2' },
  });
  assert.equal(renamed.status, 403, 'code is wired to a dispatch call site and to existing dedupe keys');

  assert.equal(
    (await h.request('PATCH', `${P}/admin/notification-templates/${seeded.uid}`, {
      token, body: { trigger_type: 'manual' },
    })).status,
    403,
  );

  const original = seeded.title;
  const reworded = await h.request('PATCH', `${P}/admin/notification-templates/${seeded.uid}`, {
    token, body: { title: 'We could not take your payment' },
  });
  assert.equal(reworded.status, 200, 'copy must stay editable — that is the point of the admin panel');
  // Model-level update, NOT seeded.update(). `seeded` was loaded before the PATCH
  // went through HTTP, so its in-memory title is still the original — Sequelize
  // would see no change and silently issue no SQL, leaving the row edited and
  // poisoning the seed-integrity test on the next run.
  await models.NotificationTemplate.update({ title: original }, { where: { id: seeded.id } });

  // DELETE is soft: a hard delete would orphan every inbox row referencing it.
  assert.equal((await h.request('DELETE', `${P}/admin/notification-templates/${seeded.uid}`, { token })).status, 200);
  const after = await models.NotificationTemplate.findOne({ where: { code: 'payment_failed' } });
  assert.ok(after, 'the row must survive DELETE');
  assert.equal(Number(after.is_active), 0);
  await after.update({ is_active: 1 });
});

test('the server owns placeholders, so an admin never maintains a variable list', async () => {
  const token = h.adminToken(['*']);

  // A built-in template may only use what its trigger actually supplies, and the
  // error has to name what that is — "you failed to declare it" was useless,
  // because the admin never chose the supply list in the first place.
  const seeded = await models.NotificationTemplate.findOne({ where: { code: 'trial_activated' } });
  const originalBody = seeded.body;

  const invented = await h.request('PATCH', `${P}/admin/notification-templates/${seeded.uid}`, {
    token, body: { body: 'Your trial started. You have {{made_up_thing}} left.' },
  });
  assert.equal(invented.status, 400);
  assert.match(invented.body.error.message, /made_up_thing/);
  assert.match(invented.body.error.message, /trial_days/, 'the error must list what IS available');

  // Dropping a placeholder to simplify the wording is now fine. Under the old
  // bidirectional contract this was a 400 ("declared but never used"), which made
  // shortening a message impossible without also editing a hidden list.
  const simplified = await h.request('PATCH', `${P}/admin/notification-templates/${seeded.uid}`, {
    token, body: { body: 'Your Premium trial has started.' },
  });
  assert.equal(simplified.status, 200);
  // Model-level update — see the note in the test above; an instance-level update
  // here is a silent no-op because `seeded` never saw the HTTP edits.
  await models.NotificationTemplate.update({ body: originalBody }, { where: { id: seeded.id } });

  // An admin-authored template has no trigger feeding it, so its placeholders are
  // simply derived from the copy — no list to keep in sync.
  const created = await h.request('POST', `${P}/admin/notification-templates`, {
    token,
    body: {
      code: `tst_derived_${Date.now()}`, title: 'Hello {{name}}',
      body: 'You have {{credits_count}} credits.', trigger_type: 'manual',
    },
  });
  assert.equal(created.status, 201);
  track.notificationTemplates.push(created.body.data.id);
  const stored = await models.NotificationTemplate.findByPk(created.body.data.id);
  assert.deepEqual([...stored.variables].sort(), ['credits_count', 'name']);

  // The two fields that used to confuse the form are no longer accepted at all.
  const sendsVariables = await h.request('POST', `${P}/admin/notification-templates`, {
    token,
    body: { code: `tst_v_${Date.now()}`, title: 'x', body: 'y', trigger_type: 'manual', variables: ['ghost'] },
  });
  assert.equal(sendsVariables.status, 400);

  const sendsPriority = await h.request('POST', `${P}/admin/notification-templates`, {
    token,
    body: { code: `tst_p_${Date.now()}`, title: 'x', body: 'y', trigger_type: 'manual', priority: 99 },
  });
  assert.equal(sendsPriority.status, 400);
});

test('a default value for a placeholder that does not exist is rejected as dead config', async () => {
  const token = h.adminToken(['*']);
  const r = await h.request('POST', `${P}/admin/notification-templates`, {
    token,
    body: {
      code: `tst_defaults_${Date.now()}`, title: 'x', body: 'plain text',
      trigger_type: 'manual', variable_defaults: { nothing_uses_this: 'oops' },
    },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /nothing_uses_this/);
});

test('campaigns are permissioned apart from the notification catalogue', async () => {
  // content_admin curates copy; blasting every user on the platform is a different
  // authority and stays with super_admin.
  const contentAdmin = h.adminToken(['notifications.*']);
  assert.equal((await h.request('GET', `${P}/admin/notification-templates`, { token: contentAdmin })).status, 200);
  assert.equal((await h.request('GET', `${P}/admin/notification-campaigns`, { token: contentAdmin })).status, 403);

  const unrelated = h.adminToken(['categories.*']);
  assert.equal((await h.request('GET', `${P}/admin/notification-templates`, { token: unrelated })).status, 403);
});

test('a campaign previews its audience, sends once, and cannot double-send on a re-run', async () => {
  const token = h.adminToken(['*']);
  const campaignSvc = require('../src/services/notificationCampaign.service');

  for (let i = 0; i < 3; i++) await makeNotifUser({ account_type: 'business' });

  const created = await h.request('POST', `${P}/admin/notification-campaigns`, {
    token,
    body: {
      name: `TST campaign ${Date.now()}`,
      title: 'We shipped 2.4', body: 'New features are live.',
      audience: { account_type: 'business' },
    },
  });
  assert.equal(created.status, 201);
  track.notificationCampaigns.push(created.body.data.id);

  const rejected = await h.request('POST', `${P}/admin/notification-campaigns`, {
    token, body: { name: 'TST bad', title: 'x', body: 'y', audience: { not_a_real_filter: true } },
  });
  assert.equal(rejected.status, 400,
    'an unrecognised filter must fail loudly — silently dropping it widens the audience');

  const preview = await h.request('GET', `${P}/admin/notification-campaigns/${created.body.data.uid}/preview`, { token });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.data.audience_count >= 3);

  assert.equal(
    (await h.request('POST', `${P}/admin/notification-campaigns/${created.body.data.uid}/send-now`, { token })).status,
    200,
  );
  await campaignSvc.runDispatchTick();

  const sent = await models.UserNotification.count({ where: { campaign_id: created.body.data.id } });
  assert.ok(sent >= 3, `expected the segment to receive it, got ${sent}`);

  // Rewind the cursor and drain again: the campaign-scoped dedupe key is what makes
  // a resumed or restarted fan-out safe.
  const row = await models.NotificationCampaign.findByPk(created.body.data.id);
  await row.update({ status: 'sending', cursor_user_id: 0 });
  await campaignSvc.runDispatchTick();
  assert.equal(await models.UserNotification.count({ where: { campaign_id: created.body.data.id } }), sent);
});

test('the retention job prunes old rows and reports how many it actually deleted', async () => {
  const user = await makeNotifUser();
  const old = await models.UserNotification.create({
    user_id: user.id, dedupe_key: `ret:${Date.now()}`, title: 'old', body: 'old',
    dismissed_at: new Date(Date.now() - 120 * 86400000),
  });
  // created_at is Sequelize-managed, so backdating it takes raw SQL.
  await models.sequelize.query('UPDATE user_notifications SET created_at = :c WHERE id = :id', {
    replacements: { c: new Date(Date.now() - 120 * 86400000), id: old.id },
  });

  const deleted = await notifyCleanup.purge();
  assert.ok(deleted >= 1, 'the count must reflect real deletions, not a discarded driver result');
  assert.equal(await models.UserNotification.findByPk(old.id), null);
});

test('the notifications permission grant is additive and idempotent', async () => {
  const migration = require('../src/db/migrations/20260101000035-role-permissions-notifications');
  const qi = models.sequelize.getQueryInterface();

  const role = await models.Role.findOne({ where: { name: 'content_admin' } });
  const before = role.permissions;
  assert.ok(before.includes('notifications.*'));

  await migration.up(qi);
  const again = await models.Role.findOne({ where: { name: 'content_admin' } });
  assert.deepEqual(again.permissions, before, 're-running must not duplicate the grant');
  // Campaigns are deliberately withheld from content_admin.
  assert.ok(!again.permissions.includes('notification_campaigns.*'));
});
