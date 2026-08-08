const bcrypt        = require('bcryptjs');
const { v4: uuid }  = require('uuid');
const userRepo      = require('../repositories/user.repository');
const adminUserRepo = require('../repositories/adminUser.repository');
const sessionRepo   = require('../repositories/userSession.repository');
const blacklistRepo = require('../repositories/tokenBlacklist.repository');
const otpRepo       = require('../repositories/otpCode.repository');
const subRepo       = require('../repositories/userSubscription.repository');
const userService   = require('./user.service');
const sessionService = require('./session.service');
const { signAccessToken, signRefreshToken, verifyToken } = require('../utils/jwtHelper');
const { generateOtp, hashOtp, verifyOtp, sendOtp }       = require('../utils/otpHelper');
const { AuthError, NotFoundError, RateLimitError }       = require('../errors');

const OTP_EXPIRY_MINUTES = 10;
const DEV_ENVS = ['development', 'staging', 'test'];

async function sendOtpService({ phone, purpose }) {
  const otp     = generateOtp();
  const hash    = await hashOtp(otp);
  const expires = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await otpRepo.model.update({ is_used: 1 }, { where: { phone, purpose, is_used: 0 } });
  await otpRepo.create({ phone, otp_hash: hash, purpose, expires_at: expires });
  await sendOtp(phone, otp);

  const result = { message: 'OTP sent successfully' };
  if (DEV_ENVS.includes(process.env.NODE_ENV)) result.otp = otp;
  return result;
}

async function verifyOtpService({ phone, otp, purpose, client_mnemonic }) {
  const record = await otpRepo.findActive(phone, purpose);
  if (!record) throw new AuthError('OTP expired or not found');

  if (record.attempts >= 5) {
    await otpRepo.update(record.id, { is_used: 1 });
    throw new RateLimitError('Too many incorrect OTP attempts');
  }

  const valid = await verifyOtp(otp, record.otp_hash);
  if (!valid) {
    await otpRepo.update(record.id, { attempts: record.attempts + 1 });
    throw new AuthError('Invalid OTP');
  }

  await otpRepo.update(record.id, { is_used: 1 });

  let user = await userRepo.findByPhone(phone);
  if (!user) {
    if (purpose === 'reset') throw new NotFoundError('No account found for this phone number');
    user = await userRepo.create({ name: phone, phone, uid: uuid() });
  }

  // A deactivated account must not be able to sign straight back in — otherwise
  // deactivation revokes every session and the very next OTP undoes it. Admin
  // login already refuses inactive accounts; this is the user-side equivalent.
  if (!user.is_active) throw new AuthError('This account has been deactivated');

  const tier   = await _resolveTier(user.id);
  const tokens = await _issueTokens(user, 'user', client_mnemonic, null, { tier });

  // `is_new_user` drives whether the app shows the personalization flow after OTP.
  // It now means "onboarding is not finished" rather than the old name-is-still-the-
  // phone-number guess, which never went false for accounts that legitimately have
  // no name (every PERSONAL account) and so reported every login as a first login.
  // `onboarding` carries the detail needed to resume on the right screen.
  const onboarding = await userService.onboardingState(user);
  return { ...tokens, is_new_user: !onboarding.completed, onboarding };
}

async function loginAdmin({ email, password }) {
  const admin = await adminUserRepo.findByEmail(email);
  if (!admin) throw new AuthError('Invalid credentials');

  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) throw new AuthError('Invalid credentials');

  if (!admin.is_active) throw new AuthError('Account is deactivated');

  const permissions = admin.Role?.permissions || [];
  return _issueTokens(admin, 'admin', 'admin_panel', permissions);
}

async function refreshTokens({ refresh_token }) {
  let payload;
  try { payload = verifyToken(refresh_token); } catch { throw new AuthError('Invalid refresh token'); }

  const session = await sessionRepo.findByJti(payload.jti);
  if (!session || session.is_revoked) throw new AuthError('Session revoked');
  if (new Date(session.expires_at) < new Date()) throw new AuthError('Session expired');

  const valid = await bcrypt.compare(refresh_token, session.refresh_token_hash);
  if (!valid) throw new AuthError('Token mismatch');

  const actorType = session.actor_type;
  const actor     = actorType === 'admin'
    ? await adminUserRepo.findById(session.actor_id)
    : await userRepo.findById(session.actor_id);

  if (!actor) throw new AuthError('Account not found');
  // Applies to users as well as admins: a deactivated account holding a valid
  // refresh token must not be able to keep renewing its access.
  if (!actor.is_active) throw new AuthError('Account is deactivated');

  await sessionRepo.revokeByJti(payload.jti);
  const permissions = actorType === 'admin' ? (actor.Role?.permissions || []) : null;
  const extra       = actorType === 'user' ? { tier: await _resolveTier(actor.id) } : {};
  return _issueTokens(actor, actorType, session.client_type, permissions, extra);
}

// A user is 'paid' when they hold an active subscription, otherwise 'free'.
// Embedded as a JWT claim so optionalAuth/rate-limiter/premium-gating can read
// it without a per-request DB lookup (refreshes on next token refresh).
async function _resolveTier(userId) {
  const sub = await subRepo.findActiveByUser(userId);
  return sub ? 'paid' : 'free';
}

// Ends the caller's own session: blacklists the access token they are holding and
// revokes the session so its refresh token can no longer mint new ones.
//
// `sid` identifies the session. Tokens issued before `sid` existed still get their
// access token blacklisted — they just cannot have their session revoked, so the
// refresh token lives until it expires. That resolves itself as old access tokens
// age out (15 minutes).
async function logout({ jti, sid, userId, actorType, expiresAt }) {
  await blacklistRepo.addToBlacklist({
    jti, actor_type: actorType, actor_id: userId, reason: 'logout', expires_at: expiresAt,
  });

  const session = await sessionService.findByUid(sid);
  if (session) await sessionRepo.revokeByJti(session.jti);
}

// Single source of truth for the access-token claim set. Both login and the
// refresh flow build the payload here so the two can never drift (a refreshed
// token must carry the same identity/authorization claims as a login token).
function buildAccessPayload(actor, actorType, clientType, permissions, extraClaims = {}) {
  return {
    sub:         actor.uid,
    userId:      actor.id,
    actor_type:  actorType,
    client_type: clientType,
    ...(actor.name  ? { name:  actor.name }  : {}),
    ...(actor.email ? { email: actor.email } : {}),
    ...(permissions ? { permissions } : {}),
    ...extraClaims,
  };
}

// The session is created BEFORE the access token is signed, because the token
// carries the session's uid as its `sid` claim. Without that link, logout has no
// way to tell which session the caller is on: it only ever saw the ACCESS token's
// jti, while sessions are keyed by the REFRESH token's — two independently random
// uuids. The old code passed one where the other was expected, so the revoke
// silently matched no row and the refresh token survived logout entirely.
async function _issueTokens(actor, actorType, clientType, permissions, extraClaims = {}) {
  const refreshToken = signRefreshToken({ sub: actor.uid, userId: actor.id, actor_type: actorType });
  const jtiRefresh   = verifyToken(refreshToken).jti;
  const sessionUid   = uuid();
  const expiresAt    = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const accessToken   = signAccessToken(
    buildAccessPayload(actor, actorType, clientType, permissions, { ...extraClaims, sid: sessionUid }),
  );
  // Read the signed token's own jti/exp rather than recomputing them, so the
  // session records exactly the token that was handed out.
  const accessClaims = verifyToken(accessToken);

  await sessionRepo.create({
    uid:                sessionUid,
    actor_type:         actorType,
    actor_id:           actor.id,
    jti:                jtiRefresh,
    refresh_token_hash: await bcrypt.hash(refreshToken, 10),
    client_type:        clientType,
    access_jti:         accessClaims.jti,
    access_expires_at:  new Date(accessClaims.exp * 1000),
    expires_at:         expiresAt,
  });

  return { access_token: accessToken, refresh_token: refreshToken };
}

module.exports = { sendOtpService, verifyOtpService, loginAdmin, refreshTokens, logout };
