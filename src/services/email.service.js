const crypto          = require('crypto');
const { Op }          = require('sequelize');
const userRepo        = require('../repositories/user.repository');
const otpChallenge    = require('./otpChallenge.service');
const activityService = require('./activity.service');
const mailer          = require('../utils/mailer');
const { maskPhone }   = require('../utils/phone');
const { hashToken }   = require('../utils/tokenHash');
const { EmailVerificationToken } = require('../models');
const { AppError, NotFoundError, ConflictError, ValidationError } = require('../errors');

// Verifying the user's email, and changing it once it is verified.
//
// A verified email is a recovery channel: "Lost my mobile" mails the phone-change
// link to it. That makes the address as sensitive as the phone, so:
//   - it only counts once the user has clicked a link sent to it
//   - changing or removing a VERIFIED address needs an OTP to the current phone,
//     otherwise a stolen session could swap in its own address and, 30 days later,
//     take the account over through the lost-phone route
//   - any change clears the verification, which restarts that 30-day clock
const LINK_TTL_HOURS = 24;

const sameEmail = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

async function _activeUser(userId) {
  const user = await userRepo.findById(userId);
  if (!user || !user.is_active) throw new NotFoundError('User not found');
  return user;
}

/** POST /users/me/email/verification — mails a verification link to the current address. */
async function sendVerification(userId) {
  const user = await _activeUser(userId);
  if (!user.email) throw new AppError('Add an email address to your profile first', 409, 'EMAIL_NOT_SET');
  if (user.email_verified_at) throw new AppError('This email address is already verified', 409, 'EMAIL_ALREADY_VERIFIED');

  // One live link at a time: requesting another retires the previous one.
  await EmailVerificationToken.update(
    { used_at: new Date() },
    { where: { user_id: user.id, used_at: null } },
  );

  const token     = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + LINK_TTL_HOURS * 60 * 60 * 1000);
  await EmailVerificationToken.create({
    user_id: user.id, email: user.email, token_hash: hashToken(token), expires_at: expiresAt,
  });

  const link = mailer.appLink('verify-email', { token });
  await mailer.sendMail({
    to:      user.email,
    subject: 'Verify your email address',
    text:    `Confirm that this is your email address for Make My Brand by opening this link:\n\n${link}\n\n`
           + `The link expires in ${LINK_TTL_HOURS} hours. If you did not ask for this, you can ignore this email.`,
    html:    `<p>Confirm that this is your email address for Make My Brand:</p>`
           + `<p><a href="${link}">Verify my email</a></p>`
           + `<p>The link expires in ${LINK_TTL_HOURS} hours. If you did not ask for this, you can ignore this email.</p>`,
  });

  return {
    message:    'Verification email sent',
    email:      mailer.maskEmail(user.email),
    expires_at: expiresAt,
    ...(mailer.echoLinks() ? { dev_link: link, dev_token: token } : {}),
  };
}

/**
 * POST /auth/email/verify — public; the token is the proof. Refused when the user
 * has changed their email since the link was sent.
 */
async function verify(token) {
  const row = await EmailVerificationToken.findOne({
    where: { token_hash: hashToken(token), used_at: null, expires_at: { [Op.gt]: new Date() } },
  });
  if (!row) throw new AppError('This link is invalid or has expired', 400, 'LINK_INVALID');

  const user = await userRepo.findById(row.user_id);
  if (!user || !user.is_active || !sameEmail(user.email, row.email)) {
    await row.update({ used_at: new Date() });
    throw new AppError('This link is invalid or has expired', 400, 'LINK_INVALID');
  }

  await row.update({ used_at: new Date() });
  if (!user.email_verified_at) await userRepo.update(user.id, { email_verified_at: new Date() });

  return { message: 'Email verified', email: mailer.maskEmail(user.email) };
}

/** POST /users/me/email/change/send-otp — OTP to the current phone, for changing a verified email. */
async function sendChangeOtp(userId) {
  const user = await _activeUser(userId);
  if (!user.phone) throw new AppError('This account has no mobile number to send an OTP to', 409, 'PHONE_NOT_SET');
  const dev = await otpChallenge.issue(user.id, 'email_change', user.phone);
  return { message: 'OTP sent', phone: maskPhone(user.phone), ...dev };
}

/**
 * PUT /users/me/email — set, replace or remove (null) the email, proven by the OTP
 * from sendChangeOtp. Works whether or not the current address is verified, but it
 * is the ONLY way to touch a verified one (PATCH /users/me refuses).
 */
async function changeEmail(req, { email, otp }) {
  const user = await _activeUser(req.user.userId);
  const next = email ? String(email).trim() : null;

  if (sameEmail(next, user.email)) throw new ValidationError('That is already your email address');
  if (next) {
    const taken = await userRepo.findByEmail(next);
    if (taken && taken.id !== user.id) throw new ConflictError('This email address is already in use');
  }

  await otpChallenge.consume(user.id, 'email_change', user.phone, otp);
  await applyEmailChange(user, next);

  await activityService.log(req, {
    action:     'email_changed',
    entityType: 'user',
    entityId:   user.id,
    metadata:   { from: mailer.maskEmail(user.email) || null, to: mailer.maskEmail(next) || null, was_verified: Boolean(user.email_verified_at) },
  });

  return { message: next ? 'Email updated' : 'Email removed', email: next, email_verified: false };
}

/**
 * The one place an email actually changes. Clears the verification, retires any
 * outstanding links, and tells the OLD verified address — the owner hears about
 * it even if the change was not theirs.
 */
async function applyEmailChange(user, next) {
  await userRepo.update(user.id, { email: next, email_verified_at: null });
  await EmailVerificationToken.update(
    { used_at: new Date() },
    { where: { user_id: user.id, used_at: null } },
  );

  if (user.email && user.email_verified_at) {
    mailer.sendMailQuietly({
      to:      user.email,
      subject: 'Your email address was changed',
      text:    'The email address on your Make My Brand account was changed. '
             + 'If you did not do this, contact support immediately.',
    });
  }
}

/**
 * Called from PATCH /users/me. A verified address cannot be changed there — it
 * needs the OTP route. An unverified one can, and the change keeps it unverified.
 */
function assertProfileEmailChangeAllowed(user, nextEmail) {
  if (nextEmail === undefined) return false;
  const next = nextEmail ? String(nextEmail).trim() : null;
  if (sameEmail(next, user.email)) return false;
  if (user.email_verified_at) {
    throw new AppError(
      'A verified email can only be changed with an OTP. Use POST /users/me/email/change/send-otp, then PUT /users/me/email.',
      403, 'EMAIL_CHANGE_REQUIRES_OTP',
    );
  }
  return true;
}

module.exports = { sendVerification, verify, sendChangeOtp, changeEmail, applyEmailChange, assertProfileEmailChangeAllowed };
