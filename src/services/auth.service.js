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
const activityService = require('./activity.service');
const { signAccessToken, signRefreshToken, verifyToken } = require('../utils/jwtHelper');
const { generateOtp, hashOtp, verifyOtp, sendOtp }       = require('../utils/otpHelper');
const { hashToken, verifyTokenHash }                     = require('../utils/tokenHash');
const { ADMIN_CLIENT_TYPE }                              = require('../utils/clientTypes');
const {
  AuthError, NotFoundError, RateLimitError, TokenReuseError, RefreshInProgressError,
} = require('../errors');

const OTP_EXPIRY_MINUTES = 10;
const DEV_ENVS = ['development', 'staging', 'test'];
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// How long after a rotation a replay of the replaced token is still assumed to be
// an innocent retry rather than a stolen token. Long enough to cover a request the
// client re-sent over a flaky connection, short enough that it is not a useful
// window for an attacker. Clients should serialize their refreshes anyway — this is
// a safety net, not a substitute for that.
const REFRESH_GRACE_MS = 15 * 1000;

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
  // Set here, never taken from the request — a user-side login cannot claim it.
  return _issueTokens(admin, 'admin', ADMIN_CLIENT_TYPE, permissions);
}

// `context.ip` is only used to attribute the audit row written when a replayed
// token is detected — worth having, since "where did the replay come from" is the
// first question asked afterwards.
async function refreshTokens({ refresh_token }, context = {}) {
  let payload;
  try { payload = verifyToken(refresh_token); } catch { throw new AuthError('Invalid refresh token'); }

  const session = await sessionRepo.findByJtiOrPrev(payload.jti);
  if (!session) throw new AuthError('Invalid refresh token');

  // The session holds two tokens: the current one and the one it replaced. Which
  // was presented decides everything below, so establish it first — and verify the
  // token against the matching hash BEFORE reacting to a replay. Reacting on the
  // jti alone would hand anyone who learned a jti the ability to log its owner out
  // on demand; only a token that provably came from us may trigger that.
  const isCurrent = session.jti === payload.jti;
  const hash      = isCurrent ? session.refresh_token_hash : session.prev_refresh_token_hash;
  if (!(await verifyTokenHash(refresh_token, hash))) throw new AuthError('Token mismatch');

  // Checked before reuse handling: a session that is already revoked or expired
  // cannot mint anything either way, and there is nothing left to protect by
  // tearing the account's other sessions down.
  if (session.is_revoked) throw new AuthError('Session revoked');
  if (new Date(session.expires_at) < new Date()) throw new AuthError('Session expired');

  if (!isCurrent) await _handleReuse(session, context);

  const actorType = session.actor_type;
  const actor     = actorType === 'admin'
    ? await adminUserRepo.findById(session.actor_id)
    : await userRepo.findById(session.actor_id);

  if (!actor) throw new AuthError('Account not found');
  // Applies to users as well as admins: a deactivated account holding a valid
  // refresh token must not be able to keep renewing its access.
  if (!actor.is_active) throw new AuthError('Account is deactivated');

  const permissions = actorType === 'admin' ? (actor.Role?.permissions || []) : null;
  const extra       = actorType === 'user' ? { tier: await _resolveTier(actor.id) } : {};
  return _rotateSession(session, actor, actorType, permissions, extra);
}

// A refresh token that has already been rotated away has turned up again, and it
// is genuinely ours. Two parties hold the chain; which one is the thief is
// unknowable from here, because both present the same valid token.
//
// So the whole account goes. That costs the legitimate user one forced login. The
// alternative — reject only the replayed token, as this used to — leaves whoever
// refreshed first holding a live token they can keep rotating for the session's
// full 30 days, and if that was the attacker the real user sees nothing but a
// single unexplained logout. One inconvenience beats a silent backdoor.
async function _handleReuse(session, { ip } = {}) {
  const rotatedAt = session.rotated_at ? new Date(session.rotated_at).getTime() : 0;
  if (Date.now() - rotatedAt < REFRESH_GRACE_MS) {
    throw new RefreshInProgressError('This refresh token was just rotated. Retry with the newest one.');
  }

  await sessionService.revokeAll(session.actor_type, session.actor_id, 'token_reuse');

  // Shaped like a request for activity.log, which only reads these three fields.
  // Without this the detection would leave no trace anywhere — the whole point is
  // being able to see it happening.
  await activityService.log(
    { user: { actor_type: session.actor_type, userId: session.actor_id }, ip },
    {
      action:     'refresh_token_reuse_detected',
      entityType: 'user_session',
      entityId:   session.id,
      metadata:   { session_uid: session.uid, client_type: session.client_type },
    },
  );

  throw new TokenReuseError('This refresh token has already been used. All sessions have been signed out.');
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
// `sid` identifies the session, and survives rotation — so this works even when the
// caller logs out with an access token from before their last refresh. Tokens issued
// before `sid` existed still get their access token blacklisted; they just cannot
// have their session revoked, so the refresh token lives until it expires. That
// resolves itself as old access tokens age out (15 minutes).
async function logout({ jti, sid, userId, actorType, expiresAt }) {
  await blacklistRepo.addToBlacklist({
    jti, actor_type: actorType, actor_id: userId, reason: 'logout', expires_at: expiresAt,
  });

  // revokeSession, not a bare revoke: it also blacklists the access token the
  // SESSION last issued, which is not necessarily the one the caller presented. A
  // client that refreshed and then logged out with the older token would otherwise
  // leave its newer access token alive for the full 15 minutes. (Blacklisting the
  // same jti twice is a no-op there, which is the common case.)
  const session = await sessionService.findByUid(sid);
  if (session) await sessionService.revokeSession(session, 'logout');
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

// Signs a matched access/refresh pair for a session that already has its uid — the
// access token carries that uid as its `sid` claim. Without that link, logout has
// no way to tell which session the caller is on: it only ever saw the ACCESS
// token's jti, while sessions are keyed by the REFRESH token's — two independently
// random uuids. The old code passed one where the other was expected, so the revoke
// silently matched no row and the refresh token survived logout entirely.
//
// The claims come back read off the signed tokens rather than recomputed, so the
// session records exactly what was handed out.
function _mintPair(actor, actorType, clientType, permissions, extraClaims, sessionUid) {
  const refreshToken = signRefreshToken({ sub: actor.uid, userId: actor.id, actor_type: actorType });
  const accessToken  = signAccessToken(
    buildAccessPayload(actor, actorType, clientType, permissions, { ...extraClaims, sid: sessionUid }),
  );

  return {
    refreshToken,
    accessToken,
    refreshClaims: verifyToken(refreshToken),
    accessClaims:  verifyToken(accessToken),
  };
}

// Opens a new session — login only. Refresh rotates an existing one in place
// instead; see _rotateSession.
async function _issueTokens(actor, actorType, clientType, permissions, extraClaims = {}) {
  const sessionUid = uuid();
  const minted     = _mintPair(actor, actorType, clientType, permissions, extraClaims, sessionUid);

  await sessionRepo.create({
    uid:                sessionUid,
    actor_type:         actorType,
    actor_id:           actor.id,
    jti:                minted.refreshClaims.jti,
    refresh_token_hash: hashToken(minted.refreshToken),
    client_type:        clientType,
    access_jti:         minted.accessClaims.jti,
    access_expires_at:  new Date(minted.accessClaims.exp * 1000),
    expires_at:         new Date(Date.now() + SESSION_TTL_MS),
  });

  return { access_token: minted.accessToken, refresh_token: minted.refreshToken };
}

// Refresh keeps the SAME session row and swaps its tokens over, recording the
// outgoing refresh token in `prev_*`. That recording is what makes reuse detection
// possible at all, and keeping the row means:
//
//   - `uid` (and so the access token's `sid`) is stable for the life of the login,
//     instead of naming a different session after every refresh
//   - `user_sessions` stops gaining a row every 15 minutes per device forever
//   - the session list reads as a list of devices rather than a churn log
//
// The write is conditional on the session still holding the token we verified, so
// two refreshes racing cannot both rotate; the loser is told to retry.
async function _rotateSession(session, actor, actorType, permissions, extraClaims = {}) {
  const minted = _mintPair(actor, actorType, session.client_type, permissions, extraClaims, session.uid);

  const rotated = await sessionRepo.rotateIfCurrent(session.id, session.jti, {
    jti:                     minted.refreshClaims.jti,
    refresh_token_hash:      hashToken(minted.refreshToken),
    prev_jti:                session.jti,
    prev_refresh_token_hash: session.refresh_token_hash,
    rotated_at:              new Date(),
    access_jti:              minted.accessClaims.jti,
    access_expires_at:       new Date(minted.accessClaims.exp * 1000),
    // The outgoing access token is still in the client's hands for the rest of its
    // 15 minutes, so it has to stay revocable rather than be overwritten.
    prev_access_jti:         session.access_jti,
    prev_access_expires_at:  session.access_expires_at,
    // Sliding, as before this change: a session in active use does not expire out
    // from under the user mid-use.
    expires_at:              new Date(Date.now() + SESSION_TTL_MS),
  });

  if (!rotated) {
    throw new RefreshInProgressError('Another refresh completed first. Retry with the newest token.');
  }

  return { access_token: minted.accessToken, refresh_token: minted.refreshToken };
}

module.exports = { sendOtpService, verifyOtpService, loginAdmin, refreshTokens, logout };
