const { toE164, normalizePhone } = require('./phone');
const { AppError } = require('../errors');

/**
 * The store-review login: ONE phone number that signs in with a fixed code instead
 * of an SMS, so Google Play's reviewers (who cannot receive our texts) can get past
 * the OTP screen. Declared in Play Console → App content → App access.
 *
 *   REVIEW_LOGIN_PHONE     the number, any spelling normalizePhone accepts
 *   REVIEW_LOGIN_OTP_HASH  bcrypt hash of the 6-digit code (npm run review:otp-hash)
 *
 * Both must be set and valid or the feature is off and that number logs in like any
 * other. The plain code lives only in the Play Console form — never in the repo, the
 * env, the database or a response. Everything else about login is unchanged: the hash
 * is stored as an ordinary OTP row, so expiry, the 5-attempt cap and the rate
 * limiters all still apply.
 *
 * Read from the environment on every call, not cached at load: turning it off is
 * editing the env and restarting, and tests switch it on and off per case.
 */

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function reviewPhone() {
  const raw = process.env.REVIEW_LOGIN_PHONE;
  return raw ? toE164(raw) : null;
}

function reviewOtpHash() {
  const hash = String(process.env.REVIEW_LOGIN_OTP_HASH || '').trim();
  return BCRYPT_HASH.test(hash) ? hash : null;
}

const isEnabled = () => Boolean(reviewPhone() && reviewOtpHash());

function isReviewPhone(phone) {
  if (!phone || !isEnabled()) return false;
  return normalizePhone(phone) === reviewPhone();
}

/**
 * For flows that would let a reviewer (or whoever learns the code) take the account
 * away from us: moving it to another number, or recovering it by email. Account
 * deletion is deliberately NOT blocked — Play policy requires it to work and
 * reviewers test it; see auth.service for how the account comes back.
 */
function assertNotReviewAccount(phone) {
  if (isReviewPhone(phone)) {
    throw new AppError('This action is not available on the review account', 403, 'REVIEW_ACCOUNT_RESTRICTED');
  }
}

// One line at boot, so a half-configured env is noticed instead of silently off.
function bootStatus() {
  const phoneSet = Boolean(process.env.REVIEW_LOGIN_PHONE);
  const hashSet  = Boolean(process.env.REVIEW_LOGIN_OTP_HASH);
  if (!phoneSet && !hashSet) return null;
  if (isEnabled()) return '[review-login] ENABLED for one number';
  if (phoneSet && !reviewPhone()) return '[review-login] DISABLED: REVIEW_LOGIN_PHONE is not an Indian mobile';
  if (hashSet && !reviewOtpHash()) return '[review-login] DISABLED: REVIEW_LOGIN_OTP_HASH is not a bcrypt hash';
  return '[review-login] DISABLED: set both REVIEW_LOGIN_PHONE and REVIEW_LOGIN_OTP_HASH';
}

module.exports = { reviewPhone, reviewOtpHash, isEnabled, isReviewPhone, assertNotReviewAccount, bootStatus };
