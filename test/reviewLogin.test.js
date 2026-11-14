// The store-review login (src/utils/reviewLogin.js): one number that signs in with
// a fixed code whose bcrypt hash is in the env, for Google Play's reviewers.
//
// Every case picks a fresh random number and switches the feature on for it, so
// runs never collide in the persistent test DB. Users and activity rows created
// here are removed afterwards.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const h = require('./helpers');

const { models } = h;
const { User, ActivityLog, OtpCode } = models;
const { Op } = require('sequelize');
const reviewLogin  = require('../src/utils/reviewLogin');
const accountPurge = require('../src/services/accountPurge.service');
const P = '/api/v1';

const CODE = '482913';
let HASH;
const track = { users: [] };
let startLogId = 0;

before(async () => {
  await models.sequelize.authenticate();
  await h.start();
  startLogId = (await ActivityLog.max('id')) || 0;
  HASH = await bcrypt.hash(CODE, 10);
});

afterEach(() => {
  delete process.env.REVIEW_LOGIN_PHONE;
  delete process.env.REVIEW_LOGIN_OTP_HASH;
});

after(async () => {
  if (track.users.length) await User.destroy({ where: { id: track.users } });
  await ActivityLog.destroy({ where: { id: { [Op.gt]: startLogId } } });
  await h.stop();
  await models.sequelize.close();
});

const randomPhone = () => `9${crypto.randomInt(100000000, 999999999)}`;
const e164 = (p) => `+91${p}`;
const post = (path, token, body) => h.request('POST', `${P}${path}`, { token, body });

function enable(phone, hash = HASH) {
  process.env.REVIEW_LOGIN_PHONE    = e164(phone);
  process.env.REVIEW_LOGIN_OTP_HASH = hash;
}

async function verify(phone, otp) {
  return post('/auth/verify-otp', null, { phone, otp, purpose: 'login', client_mnemonic: 'android' });
}

async function reviewLoginAs(phone) {
  const sent = await post('/auth/send-otp', null, { phone, purpose: 'login' });
  assert.equal(sent.status, 200);
  const r = await verify(phone, CODE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const user = await User.findOne({ where: { phone: e164(phone) } });
  if (!track.users.includes(user.id)) track.users.push(user.id);
  return { user, token: r.body.data.access_token };
}

// ---------- config ----------

test('config: off unless both vars are set and valid', () => {
  const phone = randomPhone();
  assert.equal(reviewLogin.isEnabled(), false);
  assert.equal(reviewLogin.bootStatus(), null, 'silent when unconfigured');

  process.env.REVIEW_LOGIN_PHONE = phone;
  assert.equal(reviewLogin.isEnabled(), false);
  assert.match(reviewLogin.bootStatus(), /DISABLED/);

  process.env.REVIEW_LOGIN_OTP_HASH = CODE; // a plain code is not a hash
  assert.equal(reviewLogin.isEnabled(), false);
  assert.match(reviewLogin.bootStatus(), /not a bcrypt hash/);

  process.env.REVIEW_LOGIN_OTP_HASH = HASH;
  assert.equal(reviewLogin.isEnabled(), true);
  assert.match(reviewLogin.bootStatus(), /ENABLED/);

  // Any spelling of the number matches; other numbers do not.
  assert.equal(reviewLogin.isReviewPhone(phone), true);
  assert.equal(reviewLogin.isReviewPhone(e164(phone)), true);
  assert.equal(reviewLogin.isReviewPhone(`0${phone}`), true);
  assert.equal(reviewLogin.isReviewPhone(randomPhone()), false);

  process.env.REVIEW_LOGIN_PHONE = '12345';
  assert.equal(reviewLogin.isEnabled(), false);
  assert.match(reviewLogin.bootStatus(), /not an Indian mobile/);
});

// ---------- login ----------

test('login: the review number signs in with the fixed code, and the code is never echoed', async () => {
  const phone = randomPhone();
  enable(phone);

  const sent = await post('/auth/send-otp', null, { phone: e164(phone), purpose: 'login' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.data.otp, undefined, 'not echoed, even in the test env');

  const row = await OtpCode.findOne({ where: { phone: e164(phone), is_used: 0 } });
  assert.equal(row.otp_hash, HASH, 'the env hash is stored as the OTP');

  const r = await verify(phone, CODE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.data.access_token && r.body.data.refresh_token);
  const user = await User.findOne({ where: { phone: e164(phone) } });
  track.users.push(user.id);

  const log = await ActivityLog.findOne({ where: { action: 'review_account_login', entity_id: user.id } });
  assert.ok(log, 'audited');

  // Single use, like any OTP: the next login needs a new send.
  assert.equal((await verify(phone, CODE)).status, 401);
});

test('login: a wrong code counts as an attempt, is audited, and five kill the code', async () => {
  const phone = randomPhone();
  enable(phone);
  await post('/auth/send-otp', null, { phone, purpose: 'login' });

  for (let i = 0; i < 5; i++) assert.equal((await verify(phone, '000000')).status, 401);
  assert.equal((await verify(phone, CODE)).status, 429, 'the right code is refused after the cap');

  const fails = await ActivityLog.count({ where: { action: 'review_login_failed', id: { [Op.gt]: startLogId } } });
  assert.ok(fails >= 5, 'each wrong code leaves a row');
  assert.equal(await User.count({ where: { phone: e164(phone) } }), 0, 'no account created');
});

test('login: with the feature off, the number is an ordinary one and the fixed code fails', async () => {
  const phone = randomPhone();
  const sent = await post('/auth/send-otp', null, { phone, purpose: 'login' });
  assert.match(sent.body.data.otp, /^\d{6}$/, 'normal dev echo');
  if (sent.body.data.otp !== CODE) assert.equal((await verify(phone, CODE)).status, 401);

  // And a half-configured env is off too.
  process.env.REVIEW_LOGIN_PHONE = e164(phone);
  const again = await post('/auth/send-otp', null, { phone, purpose: 'login' });
  assert.match(again.body.data.otp, /^\d{6}$/);
});

test('login: other numbers are untouched while the feature is on', async () => {
  enable(randomPhone());
  const other = randomPhone();
  const sent = await post('/auth/send-otp', null, { phone: other, purpose: 'login' });
  assert.match(sent.body.data.otp, /^\d{6}$/);
  if (sent.body.data.otp !== CODE) assert.equal((await verify(other, CODE)).status, 401);
});

// ---------- guards ----------

test('guards: the review account cannot change its number or use "Lost my mobile"', async () => {
  const phone = randomPhone();
  enable(phone);
  const { token } = await reviewLoginAs(phone);

  const start = await post('/users/me/phone-change/start', token);
  assert.equal(start.status, 403);
  assert.equal(start.body.error.code, 'REVIEW_ACCOUNT_RESTRICTED');

  const lost = await post('/users/me/phone-change/lost-phone', token);
  assert.equal(lost.status, 403);
  assert.equal(lost.body.error.code, 'REVIEW_ACCOUNT_RESTRICTED');
});

test('guards: no other account can move onto the review number', async () => {
  const reviewNumber = randomPhone();
  const mine = randomPhone();

  // An ordinary account, logged in before the feature is on.
  const sent = await post('/auth/send-otp', null, { phone: mine, purpose: 'login' });
  const login = await verify(mine, sent.body.data.otp);
  const me = await User.findOne({ where: { phone: e164(mine) } });
  track.users.push(me.id);
  const token = login.body.data.access_token;

  enable(reviewNumber);
  const started = await post('/users/me/phone-change/start', token);
  const uid = started.body.data.request_uid;
  assert.equal((await post(`/users/me/phone-change/${uid}/verify-old`, token, { otp: started.body.data.otp })).status, 200);

  const r = await post(`/users/me/phone-change/${uid}/new-phone`, token, { phone: reviewNumber });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'REVIEW_ACCOUNT_RESTRICTED');
});

// ---------- deletion ----------

test('deletion: works for a reviewer, is never purged, and the next review login brings it back', async () => {
  const phone = randomPhone();
  enable(phone);
  const { user, token } = await reviewLoginAs(phone);

  const del = await post('/users/me/deactivate', token);
  assert.equal(del.status, 200, 'Play requires deletion to work');

  // Past any grace period: still not due while it is the review number.
  await User.update({ deactivated_at: new Date(Date.now() - 365 * 24 * 3600 * 1000) }, { where: { id: user.id } });
  let due = await accountPurge.findDue(10_000);
  assert.ok(!due.some((u) => u.id === user.id), 'the review account is never purged');

  // ...but an ordinary deactivated account still is (the OR keeps the filter honest).
  const plain = await User.create({
    phone: e164(randomPhone()), uid: crypto.randomUUID(), is_active: 0,
    deactivated_at: new Date(Date.now() - 365 * 24 * 3600 * 1000),
  });
  track.users.push(plain.id);
  due = await accountPurge.findDue(10_000);
  assert.ok(due.some((u) => u.id === plain.id), 'other accounts are still purged');

  const back = await reviewLoginAs(phone);
  assert.equal(back.user.id, user.id, 'same account');
  const fresh = await User.findByPk(user.id);
  assert.equal(Boolean(fresh.is_active), true);
  assert.equal(fresh.deactivated_at, null);
});

test('deletion: an ADMIN-deactivated review account stays locked (the kill switch)', async () => {
  const phone = randomPhone();
  enable(phone);
  const { user } = await reviewLoginAs(phone);

  await User.update({ is_active: 0, deactivated_at: null }, { where: { id: user.id } });
  await post('/auth/send-otp', null, { phone, purpose: 'login' });
  const r = await verify(phone, CODE);
  assert.equal(r.status, 401);
  assert.match(r.body.error.message, /deactivated/);
});
