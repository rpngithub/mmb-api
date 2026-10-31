// Changing the login mobile number (OTP to the old number, or "Lost my mobile" via
// a verified email), and the email verification / step-up it depends on.
//
// The test DB persists between runs, so every user here is created fresh with a
// random number and destroyed afterwards. OTPs and mailed links are echoed in the
// responses in the test env, exactly as a developer would see them locally.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const h = require('./helpers');

const { models } = h;
const { User, ActivityLog, PhoneChangeRequest, UserOtpChallenge } = models;
const P = '/api/v1';
const DAY_MS = 24 * 60 * 60 * 1000;

const track = { users: [] };
let startLogId = 0;

before(async () => {
  await models.sequelize.authenticate();
  await h.start();
  startLogId = (await ActivityLog.max('id')) || 0;
});

after(async () => {
  if (track.users.length) await User.destroy({ where: { id: track.users } }); // cascades requests, OTPs, tokens
  await ActivityLog.destroy({ where: { id: { [require('sequelize').Op.gt]: startLogId } } });
  await h.stop();
  await models.sequelize.close();
});

const randomPhone = () => `9${crypto.randomInt(100000000, 999999999)}`;
const randomEmail = () => `tst-phone-${crypto.randomBytes(6).toString('hex')}@example.com`;
const e164 = (p) => `+91${p}`;

// A real login, so the session row exists and revocation can be observed.
async function login(phone = randomPhone()) {
  const sent = await h.request('POST', `${P}/auth/send-otp`, { body: { phone, purpose: 'login' } });
  const r = await h.request('POST', `${P}/auth/verify-otp`, {
    body: { phone, otp: sent.body.data.otp, purpose: 'login', client_mnemonic: 'android' },
  });
  assert.equal(r.status, 200, 'login');
  const user = await User.findOne({ where: { phone: e164(phone) } });
  track.users.push(user.id);
  return { phone, user, token: r.body.data.access_token, refresh: r.body.data.refresh_token };
}

const post = (path, token, body) => h.request('POST', `${P}${path}`, { token, body });
const get  = (path, token) => h.request('GET', `${P}${path}`, { token });

// Email set and verified `daysAgo` days ago, written directly.
async function giveVerifiedEmail(user, daysAgo) {
  await User.update(
    { email: randomEmail(), email_verified_at: new Date(Date.now() - daysAgo * DAY_MS) },
    { where: { id: user.id } },
  );
}

// ---------- options ----------

test('options: OTP to the current number, and why "Lost my mobile" is unavailable', async () => {
  const a = await login();

  let r = await get('/users/me/phone-change/options', a.token);
  assert.equal(r.status, 200);
  assert.match(r.body.data.current_phone, /^\+91 \d{2}x{6}\d{2}$/);
  assert.equal(r.body.data.otp_to_current.available, true);
  assert.deepEqual(r.body.data.lost_phone, { available: false, reason: 'EMAIL_NOT_SET', email: null });

  await User.update({ email: randomEmail() }, { where: { id: a.user.id } });
  r = await get('/users/me/phone-change/options', a.token);
  assert.equal(r.body.data.lost_phone.reason, 'EMAIL_NOT_VERIFIED');

  await User.update({ email_verified_at: new Date(Date.now() - 5 * DAY_MS) }, { where: { id: a.user.id } });
  r = await get('/users/me/phone-change/options', a.token);
  assert.equal(r.body.data.lost_phone.reason, 'EMAIL_VERIFICATION_TOO_RECENT');
  const eligible = new Date(r.body.data.lost_phone.eligible_from).getTime();
  assert.ok(Math.abs(eligible - (Date.now() + 25 * DAY_MS)) < 60_000, 'eligible 30 days after verification');

  await User.update({ email_verified_at: new Date(Date.now() - 31 * DAY_MS) }, { where: { id: a.user.id } });
  r = await get('/users/me/phone-change/options', a.token);
  assert.equal(r.body.data.lost_phone.available, true);
  assert.match(r.body.data.lost_phone.email, /^ts\*\*\*@example\.com$/);
});

// ---------- option 1: OTP to the old number ----------

test('option 1: old OTP, then new OTP, swaps the number and ends every other session', async () => {
  const a = await login();
  const otherDevice = await h.request('POST', `${P}/auth/verify-otp`, {
    body: { phone: a.phone, otp: (await post('/auth/send-otp', null, { phone: a.phone, purpose: 'login' })).body.data.otp, purpose: 'login', client_mnemonic: 'web' },
  });
  const newPhone = randomPhone();

  const started = await post('/users/me/phone-change/start', a.token);
  assert.equal(started.status, 200);
  assert.equal(started.body.data.next_step, 'verify_old');
  const uid = started.body.data.request_uid;

  assert.equal((await post(`/users/me/phone-change/${uid}/verify-old`, a.token, { otp: '000000' })).status, 401);
  const old = await post(`/users/me/phone-change/${uid}/verify-old`, a.token, { otp: started.body.data.otp });
  assert.equal(old.status, 200);
  assert.equal(old.body.data.next_step, 'new_phone');

  const sent = await post(`/users/me/phone-change/${uid}/new-phone`, a.token, { phone: newPhone });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.data.next_step, 'verify_new');

  const done = await post(`/users/me/phone-change/${uid}/verify-new`, a.token, { otp: sent.body.data.otp });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.phone, e164(newPhone));
  assert.ok(done.body.data.access_token && done.body.data.refresh_token, 'this device gets a fresh session');

  assert.equal((await User.findByPk(a.user.id)).phone, e164(newPhone));

  // Every earlier token is dead, on both devices; the fresh one works.
  assert.equal((await get('/users/me', a.token)).status, 401);
  assert.equal((await get('/users/me', otherDevice.body.data.access_token)).status, 401);
  assert.equal((await post('/auth/refresh', null, { refresh_token: a.refresh })).status, 401);
  assert.equal((await get('/users/me', done.body.data.access_token)).status, 200);

  // The new number logs into the same account.
  const relogin = await login(newPhone);
  assert.equal(relogin.user.id, a.user.id, 'new number signs into the same account');

  const log = await ActivityLog.findOne({ where: { action: 'phone_changed', entity_id: a.user.id } });
  assert.ok(log, 'audited');
  const meta = typeof log.metadata === 'string' ? JSON.parse(log.metadata) : log.metadata;
  assert.equal(meta.method, 'old_phone');
});

test('option 1: steps must happen in order, and only on your own request', async () => {
  const a = await login();
  const b = await login();

  const started = await post('/users/me/phone-change/start', a.token);
  const uid = started.body.data.request_uid;

  // New number before the old one is confirmed.
  const early = await post(`/users/me/phone-change/${uid}/new-phone`, a.token, { phone: randomPhone() });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'STEP_OUT_OF_ORDER');

  // Someone else's request is invisible.
  assert.equal((await post(`/users/me/phone-change/${uid}/verify-old`, b.token, { otp: started.body.data.otp })).status, 404);

  // B's OTP cannot confirm A's step: OTPs are bound to the account.
  const bStarted = await post('/users/me/phone-change/start', b.token);
  if (bStarted.body.data.otp !== started.body.data.otp) {
    assert.equal((await post(`/users/me/phone-change/${uid}/verify-old`, a.token, { otp: bStarted.body.data.otp })).status, 401,
      'another account\'s OTP is rejected');
  }

  assert.equal((await post(`/users/me/phone-change/${uid}/verify-old`, a.token, { otp: started.body.data.otp })).status, 200);

  // Own number, someone else's number.
  const same = await post(`/users/me/phone-change/${uid}/new-phone`, a.token, { phone: a.phone });
  assert.equal(same.status, 400);
  const taken = await post(`/users/me/phone-change/${uid}/new-phone`, a.token, { phone: b.phone });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'PHONE_TAKEN');

  // verify-new before a new number was given is out of order too.
  const noNew = await post(`/users/me/phone-change/${uid}/verify-new`, a.token, { otp: '123456' });
  assert.equal(noNew.status, 409);

  // Starting again retires the old request.
  await post('/users/me/phone-change/start', a.token);
  assert.equal((await PhoneChangeRequest.findOne({ where: { uid } })).status, 'cancelled');
  assert.equal((await post(`/users/me/phone-change/${uid}/new-phone`, a.token, { phone: randomPhone() })).status, 404);
});

test('option 1: five wrong OTPs kill the code; an expired request is gone', async () => {
  const a = await login();
  const started = await post('/users/me/phone-change/start', a.token);
  const uid = started.body.data.request_uid;

  for (let i = 0; i < 5; i++) {
    assert.equal((await post(`/users/me/phone-change/${uid}/verify-old`, a.token, { otp: '000000' })).status, 401);
  }
  assert.equal((await post(`/users/me/phone-change/${uid}/verify-old`, a.token, { otp: started.body.data.otp })).status, 429);
  assert.equal((await post(`/users/me/phone-change/${uid}/verify-old`, a.token, { otp: started.body.data.otp })).status, 401, 'dead after the cap');

  const again = await post('/users/me/phone-change/start', a.token);
  await PhoneChangeRequest.update({ expires_at: new Date(Date.now() - 1000) }, { where: { uid: again.body.data.request_uid } });
  assert.equal((await post(`/users/me/phone-change/${again.body.data.request_uid}/verify-old`, a.token, { otp: again.body.data.otp })).status, 404);

  assert.equal((await User.findByPk(a.user.id)).phone, e164(a.phone), 'number unchanged');
});

test('option 1: a number taken between the OTP and the swap is refused', async () => {
  const a = await login();
  const target = randomPhone();

  const started = await post('/users/me/phone-change/start', a.token);
  const uid = started.body.data.request_uid;
  await post(`/users/me/phone-change/${uid}/verify-old`, a.token, { otp: started.body.data.otp });
  const sent = await post(`/users/me/phone-change/${uid}/new-phone`, a.token, { phone: target });

  await login(target); // someone else signs up with it meanwhile

  const done = await post(`/users/me/phone-change/${uid}/verify-new`, a.token, { otp: sent.body.data.otp });
  assert.equal(done.status, 409);
  assert.equal(done.body.error.code, 'PHONE_TAKEN');
  assert.equal((await User.findByPk(a.user.id)).phone, e164(a.phone));
});

// ---------- option 2: lost my mobile ----------

test('lost my mobile: refused unless the email was verified at least 30 days ago', async () => {
  const a = await login();

  let r = await post('/users/me/phone-change/lost-phone', a.token);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'EMAIL_NOT_SET');

  await User.update({ email: randomEmail() }, { where: { id: a.user.id } });
  r = await post('/users/me/phone-change/lost-phone', a.token);
  assert.equal(r.body.error.code, 'EMAIL_NOT_VERIFIED');

  await User.update({ email_verified_at: new Date(Date.now() - 29 * DAY_MS) }, { where: { id: a.user.id } });
  r = await post('/users/me/phone-change/lost-phone', a.token);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'EMAIL_VERIFICATION_TOO_RECENT');
  assert.ok(r.body.error.details[0].eligible_from, 'says when it opens');

  assert.equal(await PhoneChangeRequest.count({ where: { user_id: a.user.id } }), 0, 'nothing created');
});

test('lost my mobile: the emailed link sets a new number and ends every session', async () => {
  const a = await login();
  await giveVerifiedEmail(a.user, 31);
  const newPhone = randomPhone();

  const r = await post('/users/me/phone-change/lost-phone', a.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.data.dev_link, /\/change-phone\?token=/);
  const token = r.body.data.dev_token;

  // Opening the link is read-only — twice is fine.
  for (let i = 0; i < 2; i++) {
    const seen = await get(`/auth/phone-reset/${token}`);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.data.next_step, 'new_phone');
  }

  assert.equal((await post('/auth/phone-reset/verify', null, { token, otp: '123456' })).status, 409, 'number first');

  const sent = await post('/auth/phone-reset/send-otp', null, { token, phone: newPhone });
  assert.equal(sent.status, 200);
  assert.equal((await get(`/auth/phone-reset/${token}`)).body.data.next_step, 'verify_new');

  assert.equal((await post('/auth/phone-reset/verify', null, { token, otp: '000000' })).status, 401);
  const done = await post('/auth/phone-reset/verify', null, { token, otp: sent.body.data.otp });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.access_token, undefined, 'no session from a link');

  assert.equal((await User.findByPk(a.user.id)).phone, e164(newPhone));
  assert.equal((await get('/users/me', a.token)).status, 401, 'the old session is dead');

  // Single use.
  const reused = await get(`/auth/phone-reset/${token}`);
  assert.equal(reused.status, 400);
  assert.equal(reused.body.error.code, 'LINK_INVALID');
});

test('lost my mobile: a new link retires the previous one, and junk tokens are refused', async () => {
  const a = await login();
  await giveVerifiedEmail(a.user, 40);

  const first  = await post('/users/me/phone-change/lost-phone', a.token);
  const second = await post('/users/me/phone-change/lost-phone', a.token);
  assert.equal((await get(`/auth/phone-reset/${first.body.data.dev_token}`)).status, 400);
  assert.equal((await get(`/auth/phone-reset/${second.body.data.dev_token}`)).status, 200);

  assert.equal((await get(`/auth/phone-reset/${'x'.repeat(43)}`)).status, 400);
  assert.equal((await post('/auth/phone-reset/send-otp', null, { token: 'short', phone: randomPhone() })).status, 400);
});

// ---------- email verification and the verified-email step-up ----------

test('email verification: the link verifies the address it was sent to, once', async () => {
  const a = await login();
  const email = randomEmail();
  assert.equal((await h.request('PATCH', `${P}/users/me`, { token: a.token, body: { email } })).status, 200);

  const sent = await post('/users/me/email/verification', a.token);
  assert.equal(sent.status, 200);
  assert.match(sent.body.data.dev_link, /\/verify-email\?token=/);

  const ok = await post('/auth/email/verify', null, { token: sent.body.data.dev_token });
  assert.equal(ok.status, 200);
  const me = await get('/users/me', a.token);
  assert.equal(me.body.data.email_verified, true);

  assert.equal((await post('/auth/email/verify', null, { token: sent.body.data.dev_token })).status, 400, 'single use');
  assert.equal((await post('/users/me/email/verification', a.token)).body.error.code, 'EMAIL_ALREADY_VERIFIED');
});

test('email verification: a link for an address the user has since replaced is refused', async () => {
  const a = await login();
  await h.request('PATCH', `${P}/users/me`, { token: a.token, body: { email: randomEmail() } });
  const sent = await post('/users/me/email/verification', a.token);

  // Still unverified, so PATCH may change it — which strands the old link.
  await h.request('PATCH', `${P}/users/me`, { token: a.token, body: { email: randomEmail() } });
  const r = await post('/auth/email/verify', null, { token: sent.body.data.dev_token });
  assert.equal(r.status, 400);
  assert.equal((await User.findByPk(a.user.id)).email_verified_at, null);
});

test('a verified email changes only with an OTP to the phone, and loses its verification', async () => {
  const a = await login();
  await giveVerifiedEmail(a.user, 60);
  const next = randomEmail();

  const patched = await h.request('PATCH', `${P}/users/me`, { token: a.token, body: { email: next } });
  assert.equal(patched.status, 403);
  assert.equal(patched.body.error.code, 'EMAIL_CHANGE_REQUIRES_OTP');

  // Name-only PATCH still works with a verified email in place.
  assert.equal((await h.request('PATCH', `${P}/users/me`, { token: a.token, body: { name: 'Pat' } })).status, 200);

  const otp = await post('/users/me/email/change/send-otp', a.token);
  assert.equal(otp.status, 200);
  assert.equal((await h.request('PUT', `${P}/users/me/email`, { token: a.token, body: { email: next, otp: '000000' } })).status, 401);
  const changed = await h.request('PUT', `${P}/users/me/email`, { token: a.token, body: { email: next, otp: otp.body.data.otp } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  const u = await User.findByPk(a.user.id);
  assert.equal(u.email, next);
  assert.equal(u.email_verified_at, null, 'the 30-day clock restarts');
  assert.equal((await post('/users/me/phone-change/lost-phone', a.token)).body.error.code, 'EMAIL_NOT_VERIFIED');
  assert.equal(await UserOtpChallenge.count({ where: { user_id: a.user.id, purpose: 'email_change', used_at: null } }), 0);
});
