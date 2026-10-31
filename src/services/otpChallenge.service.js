const { Op }                = require('sequelize');
const { UserOtpChallenge }  = require('../models');
const { generateOtp, hashOtp, verifyOtp, sendOtp } = require('../utils/otpHelper');
const { AuthError, RateLimitError } = require('../errors');

// OTPs that prove something about ONE signed-in account (see the model). Same
// lifetime, attempt cap and dev echo as the login OTP in auth.service, so the two
// behave alike from the app's side.
const OTP_EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS       = 5;
const DEV_ENVS = ['development', 'test'];

/**
 * Texts a fresh OTP to `phone` for (user, purpose). Any earlier unused one for the
 * same pair dies, so "resend" never leaves two live codes. Returns the code itself
 * only in development/test, mirroring send-otp.
 */
async function issue(userId, purpose, phone) {
  const otp = generateOtp();
  await UserOtpChallenge.update(
    { used_at: new Date() },
    { where: { user_id: userId, purpose, used_at: null } },
  );
  await UserOtpChallenge.create({
    user_id:    userId,
    purpose,
    phone,
    otp_hash:   await hashOtp(otp),
    expires_at: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
  });
  await sendOtp(phone, otp);
  return DEV_ENVS.includes(process.env.NODE_ENV) ? { otp } : {};
}

/**
 * Checks and consumes the live OTP for (user, purpose) sent to `phone`. Throws on
 * anything but a match; a match is single-use.
 */
async function consume(userId, purpose, phone, otp) {
  const row = await UserOtpChallenge.findOne({
    where: { user_id: userId, purpose, phone, used_at: null, expires_at: { [Op.gt]: new Date() } },
    order: [['id', 'DESC']],
  });
  if (!row) throw new AuthError('OTP expired or not found');

  if (row.attempts >= MAX_ATTEMPTS) {
    await row.update({ used_at: new Date() });
    throw new RateLimitError('Too many incorrect OTP attempts');
  }

  if (!(await verifyOtp(otp, row.otp_hash))) {
    await row.update({ attempts: row.attempts + 1 });
    throw new AuthError('Invalid OTP');
  }

  await row.update({ used_at: new Date() });
}

function purgeExpired() {
  return UserOtpChallenge.destroy({ where: { expires_at: { [Op.lt]: new Date() } } });
}

module.exports = { issue, consume, purgeExpired, OTP_EXPIRY_MINUTES };
