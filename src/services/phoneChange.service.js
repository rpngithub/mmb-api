const crypto          = require('crypto');
const { Op }          = require('sequelize');
const userRepo        = require('../repositories/user.repository');
const otpChallenge    = require('./otpChallenge.service');
const sessionService  = require('./session.service');
const activityService = require('./activity.service');
const authService     = require('./auth.service');
const notify          = require('./notification.service');
const dedupe          = require('../utils/dedupeKey');
const mailer          = require('../utils/mailer');
const { hashToken }   = require('../utils/tokenHash');
const { normalizePhone, maskPhone } = require('../utils/phone');
const { PhoneChangeRequest, OtpCode, sequelize } = require('../models');
const { AppError, NotFoundError, ConflictError, ValidationError } = require('../errors');

/**
 * Changing the login mobile number. Every route starts from a signed-in user, but
 * the session alone is never enough: a stolen access token must not be able to
 * move the account onto the thief's phone. So each method needs a second proof
 * that only the real owner has.
 *
 *   old_phone  (the user still has the current number)
 *     POST /users/me/phone-change/start            OTP to the CURRENT number
 *     POST /users/me/phone-change/:uid/verify-old  confirm it
 *     POST /users/me/phone-change/:uid/new-phone   OTP to the NEW number
 *     POST /users/me/phone-change/:uid/verify-new  confirm it -> number swapped
 *
 *   email_link  ("Lost my mobile")
 *     POST /users/me/phone-change/lost-phone       link to the verified email, which
 *                                                  must be verified >= 30 days ago
 *     GET  /auth/phone-reset/:token                link opened (read-only)
 *     POST /auth/phone-reset/send-otp              OTP to the NEW number
 *     POST /auth/phone-reset/verify                confirm it -> number swapped
 *
 * The link's steps are public: whoever lost their phone may well open the email on
 * another device, so the token in the link is the credential there, not the JWT.
 *
 * Either way the new number must also pass an OTP, so nobody can set a number they
 * do not hold. On success every session for the account ends.
 */
const REQUEST_TTL_MINUTES = 15;
const LINK_TTL_MINUTES    = 30;
// An address verified more recently than this is not trusted for recovery: a
// stolen session could have planted it. The real owner has a month to notice the
// "email changed" notices and react.
const EMAIL_MIN_AGE_DAYS  = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

async function _activeUser(userId) {
  const user = await userRepo.findById(userId);
  if (!user || !user.is_active) throw new NotFoundError('User not found');
  return user;
}

// Whether "Lost my mobile" is open to this user right now, and if not, why.
function lostPhoneEligibility(user, now = new Date()) {
  const email = user.email ? mailer.maskEmail(user.email) : null;
  if (!user.email) return { available: false, reason: 'EMAIL_NOT_SET', email };
  if (!user.email_verified_at) return { available: false, reason: 'EMAIL_NOT_VERIFIED', email };

  const eligibleFrom = new Date(new Date(user.email_verified_at).getTime() + EMAIL_MIN_AGE_DAYS * DAY_MS);
  if (eligibleFrom > now) {
    return { available: false, reason: 'EMAIL_VERIFICATION_TOO_RECENT', email, eligible_from: eligibleFrom };
  }
  return { available: true, reason: null, email };
}

const ELIGIBILITY_MESSAGES = {
  EMAIL_NOT_SET:                 'Add an email address to your profile and verify it to use this option',
  EMAIL_NOT_VERIFIED:            'Verify your email address to use this option',
  EMAIL_VERIFICATION_TOO_RECENT: `Your email must have been verified at least ${EMAIL_MIN_AGE_DAYS} days ago to use this option`,
};

/** GET /users/me/phone-change/options — what the "Change my mobile number" screen offers. */
async function options(userId) {
  const user = await _activeUser(userId);
  return {
    current_phone:  maskPhone(user.phone),
    otp_to_current: { available: Boolean(user.phone) },
    lost_phone:     lostPhoneEligibility(user),
  };
}

// A user has at most one live request: starting another retires the rest.
async function _cancelOpen(userId) {
  await PhoneChangeRequest.update({ status: 'cancelled' }, { where: { user_id: userId, status: 'open' } });
}

const _isLive = (req) => req && req.status === 'open' && new Date(req.expires_at) > new Date();

// ---------------------------------------------------------------------------
// old_phone
// ---------------------------------------------------------------------------

async function start(req) {
  const user = await _activeUser(req.user.userId);
  if (!user.phone) throw new AppError('This account has no mobile number', 409, 'PHONE_NOT_SET');

  await _cancelOpen(user.id);
  const request = await PhoneChangeRequest.create({
    user_id:    user.id,
    method:     'old_phone',
    old_phone:  user.phone,
    expires_at: new Date(Date.now() + REQUEST_TTL_MINUTES * 60 * 1000),
    ip_address: req.ip,
  });
  const dev = await otpChallenge.issue(user.id, 'phone_change_old', user.phone);

  return {
    request_uid: request.uid,
    phone:       maskPhone(user.phone),
    expires_at:  request.expires_at,
    next_step:   'verify_old',
    ...dev,
  };
}

// The caller's own live old_phone request. Someone else's uid is a plain 404 —
// the same as one that does not exist.
async function _ownRequest(userId, uid) {
  const request = await PhoneChangeRequest.findOne({ where: { uid, user_id: userId, method: 'old_phone' } });
  if (!_isLive(request)) throw new NotFoundError('Phone change request not found or expired. Start again.');
  return request;
}

async function verifyOld(userId, uid, { otp }) {
  const request = await _ownRequest(userId, uid);
  if (request.old_verified_at) throw new AppError('The current number is already confirmed', 409, 'STEP_OUT_OF_ORDER');

  await otpChallenge.consume(userId, 'phone_change_old', request.old_phone, otp);
  await request.update({ old_verified_at: new Date() });
  return { request_uid: request.uid, next_step: 'new_phone' };
}

async function submitNewPhone(userId, uid, { phone }) {
  const request = await _ownRequest(userId, uid);
  if (!request.old_verified_at) {
    throw new AppError('Confirm the OTP sent to your current number first', 409, 'STEP_OUT_OF_ORDER');
  }
  return _sendNewPhoneOtp(request, phone);
}

async function verifyNew(req, uid, { otp }) {
  const request = await _ownRequest(req.user.userId, uid);
  if (!request.old_verified_at || !request.new_phone) {
    throw new AppError('Enter the new number first', 409, 'STEP_OUT_OF_ORDER');
  }
  const user = await _complete(request, otp, req);

  // Every session has just ended, the caller's included. The device that ran the
  // change has proved both numbers, so it is handed a fresh session rather than
  // being thrown back to the login screen.
  const tokens = await authService.issueUserSession(user, req.user.client_type || null);
  return { message: 'Mobile number changed', phone: user.phone, ...tokens };
}

// ---------------------------------------------------------------------------
// email_link
// ---------------------------------------------------------------------------

async function lostPhone(req) {
  const user = await _activeUser(req.user.userId);
  if (!user.phone) throw new AppError('This account has no mobile number', 409, 'PHONE_NOT_SET');

  const eligibility = lostPhoneEligibility(user);
  if (!eligibility.available) {
    throw new AppError(ELIGIBILITY_MESSAGES[eligibility.reason], 403, eligibility.reason, [{
      field:   'email',
      message: ELIGIBILITY_MESSAGES[eligibility.reason],
      ...(eligibility.eligible_from ? { eligible_from: eligibility.eligible_from } : {}),
    }]);
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await _cancelOpen(user.id);
  const request = await PhoneChangeRequest.create({
    user_id:         user.id,
    method:          'email_link',
    old_phone:       user.phone,
    link_token_hash: hashToken(token),
    expires_at:      new Date(Date.now() + LINK_TTL_MINUTES * 60 * 1000),
    ip_address:      req.ip,
  });

  const link = mailer.appLink('change-phone', { token });
  try {
    await mailer.sendMail({
      to:      user.email,
      subject: 'Change your mobile number',
      text:    'You asked to change the mobile number on your Make My Brand account because you no longer have it. '
             + `Open this link to set a new number:\n\n${link}\n\n`
             + `The link expires in ${LINK_TTL_MINUTES} minutes and works once. `
             + 'If you did not ask for this, ignore this email and contact support — someone may be signed in to your account.',
      html:    '<p>You asked to change the mobile number on your Make My Brand account because you no longer have it.</p>'
             + `<p><a href="${link}">Set a new mobile number</a></p>`
             + `<p>The link expires in ${LINK_TTL_MINUTES} minutes and works once.</p>`
             + '<p>If you did not ask for this, ignore this email and contact support — someone may be signed in to your account.</p>',
    });
  } catch (err) {
    // A link nobody received must not stay usable.
    await request.update({ status: 'cancelled' });
    throw err;
  }

  return {
    message:    'We have emailed you a link to change your mobile number',
    email:      eligibility.email,
    expires_at: request.expires_at,
    ...(mailer.echoLinks() ? { dev_link: link, dev_token: token } : {}),
  };
}

async function _linkRequest(token) {
  const request = await PhoneChangeRequest.findOne({
    where: { link_token_hash: hashToken(String(token)), method: 'email_link' },
  });
  if (!_isLive(request)) throw new AppError('This link is invalid or has expired', 400, 'LINK_INVALID');
  return request;
}

/**
 * GET /auth/phone-reset/:token — read-only on purpose. Mail scanners (Outlook Safe
 * Links and the like) open links before the user does; if this consumed anything,
 * the user would arrive at a dead link.
 */
async function inspectLink(token) {
  const request = await _linkRequest(token);
  return {
    current_phone: maskPhone(request.old_phone),
    expires_at:    request.expires_at,
    next_step:     request.new_phone ? 'verify_new' : 'new_phone',
    ...(request.new_phone ? { new_phone: maskPhone(request.new_phone) } : {}),
  };
}

async function linkSendOtp({ token, phone }) {
  const request = await _linkRequest(token);
  await _activeUser(request.user_id);
  return _sendNewPhoneOtp(request, phone);
}

async function linkVerify(req, { token, otp }) {
  const request = await _linkRequest(token);
  if (!request.new_phone) throw new AppError('Enter the new number first', 409, 'STEP_OUT_OF_ORDER');
  const user = await _complete(request, otp, req);
  // No session is issued: this may be a browser on someone else's laptop. The user
  // signs in with the new number.
  return { message: 'Mobile number changed. Sign in with your new number.', phone: maskPhone(user.phone) };
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

async function _sendNewPhoneOtp(request, rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (phone === request.old_phone) throw new ValidationError('That is already your mobile number');

  const taken = await userRepo.findByPhone(phone);
  if (taken && taken.id !== request.user_id) {
    throw new AppError('This mobile number is already registered to another account', 409, 'PHONE_TAKEN');
  }

  await request.update({ new_phone: phone });
  const dev = await otpChallenge.issue(request.user_id, 'phone_change_new', phone);
  return { phone: maskPhone(phone), next_step: 'verify_new', ...dev };
}

/**
 * Confirms the OTP to the new number and swaps it in. The user row is locked for
 * the swap, and both preconditions are re-checked inside the transaction: the
 * number being replaced is still the account's, and the new one is still free. The
 * unique index on users.phone is the last word if two accounts race for a number.
 */
async function _complete(request, otp, req) {
  await otpChallenge.consume(request.user_id, 'phone_change_new', request.new_phone, otp);

  let user;
  try {
    user = await sequelize.transaction(async (transaction) => {
      const u = await userRepo.findById(request.user_id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!u || !u.is_active) throw new NotFoundError('User not found');
      if (u.phone !== request.old_phone) {
        throw new ConflictError('Your mobile number changed while this request was open. Start again.');
      }
      const taken = await userRepo.findOne({ phone: request.new_phone, id: { [Op.ne]: u.id } }, { transaction });
      if (taken) throw new AppError('This mobile number is already registered to another account', 409, 'PHONE_TAKEN');

      await u.update({ phone: request.new_phone }, { transaction });
      await request.update({ status: 'completed', completed_at: new Date() }, { transaction });
      // Login codes already texted to the old number must not outlive the change.
      await OtpCode.update({ is_used: 1 }, { where: { phone: request.old_phone, is_used: 0 }, transaction });
      return u;
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw new AppError('This mobile number is already registered to another account', 409, 'PHONE_TAKEN');
    }
    throw err;
  }

  // Including any stolen token — the point of the exercise.
  await sessionService.revokeAll('user', user.id, 'phone_changed');

  await activityService.log(
    { user: { actor_type: 'user', userId: user.id }, ip: req.ip },
    {
      action:     'phone_changed',
      entityType: 'user',
      entityId:   user.id,
      metadata:   { method: request.method, request_uid: request.uid, from: maskPhone(request.old_phone), to: maskPhone(request.new_phone) },
    },
  );

  notify.notify({
    code:      'phone_number_changed',
    userId:    user.id,
    variables: { phone: maskPhone(user.phone) },
    dedupeKey: dedupe.forEntity('phone_number_changed', 'phone_change_request', request.id),
  });

  if (user.email && user.email_verified_at) {
    mailer.sendMailQuietly({
      to:      user.email,
      subject: 'Your mobile number was changed',
      text:    `The login mobile number on your Make My Brand account was changed to ${maskPhone(user.phone)}. `
             + 'You have been signed out everywhere. If you did not do this, contact support immediately.',
    });
  }

  return user;
}

module.exports = {
  options, start, verifyOld, submitNewPhone, verifyNew,
  lostPhone, inspectLink, linkSendOtp, linkVerify,
  lostPhoneEligibility, EMAIL_MIN_AGE_DAYS,
};
