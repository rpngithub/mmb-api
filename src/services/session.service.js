const { Op }        = require('sequelize');
const sessionRepo   = require('../repositories/userSession.repository');
const blacklistRepo = require('../repositories/tokenBlacklist.repository');

// Revoking a session has to do TWO things to actually log someone out:
//
//   1. mark the session revoked  — stops the refresh token minting new access tokens
//   2. blacklist its access token — stops the one already in the user's hands
//
// Doing only (1) leaves the device working for up to the access token's lifetime,
// which is the wrong answer for "log out the laptop I just sold". Doing only (2)
// lets them refresh straight back in. The session row records `access_jti` so both
// are possible from one place.
// Both access tokens are blacklisted, not just the newest. A session that refreshed
// recently has handed the client TWO live access tokens — the new one and the one it
// replaced, still good for the rest of its 15 minutes. Killing only the newest left
// the older one working, so "sign out my other devices" did not actually sign them
// out. Anything older than those two has already expired on its own.
async function revokeSession(session, reason = 'logout') {
  if (!session) return;

  await sessionRepo.revokeByJti(session.jti);

  await _blacklistAccessToken(session, session.access_jti, session.access_expires_at, reason);
  await _blacklistAccessToken(session, session.prev_access_jti, session.prev_access_expires_at, reason);
}

async function _blacklistAccessToken(session, jti, expiresAtRaw, reason) {
  // Nothing to do when there is no such token: a session predating these columns, or
  // one that has never rotated and so has no previous token.
  if (!jti) return;

  // An access token that has already expired needs no blacklisting.
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
  if (expiresAt && expiresAt <= new Date()) return;

  try {
    await blacklistRepo.addToBlacklist({
      jti,
      actor_type: session.actor_type,
      actor_id:   session.actor_id,
      reason,
      // Fall back to the session's own expiry if the access expiry wasn't recorded;
      // an over-long blacklist row is harmless (purgeExpired sweeps it) whereas a
      // missing one means the token keeps working.
      expires_at: expiresAt || session.expires_at,
    });
  } catch (err) {
    // jti is unique — a token already blacklisted (double logout, or the caller's own
    // token which logout blacklists directly) is a no-op, not a failure. Anything
    // else is real and should surface.
    if (err.name !== 'SequelizeUniqueConstraintError') throw err;
  }
}

// Every live session for an actor, optionally excluding one (the caller's own, so
// "log out everywhere else" leaves the device you are holding signed in).
function liveSessions(actorType, actorId, exceptUid = null) {
  const where = { actor_type: actorType, actor_id: actorId, is_revoked: 0 };
  if (exceptUid) where.uid = { [Op.ne]: exceptUid };
  return sessionRepo.findMany(where);
}

// "Log out of all other devices". Returns how many were ended so the caller can
// report it back.
async function revokeOthers(actorType, actorId, currentSessionUid, reason = 'revoked') {
  const sessions = await liveSessions(actorType, actorId, currentSessionUid);
  for (const s of sessions) await revokeSession(s, reason);
  return sessions.length;
}

// Everything, including the caller's own — used by deactivate.
async function revokeAll(actorType, actorId, reason = 'revoked') {
  const sessions = await liveSessions(actorType, actorId);
  for (const s of sessions) await revokeSession(s, reason);
  return sessions.length;
}

// The session an access token belongs to, via its `sid` claim. Null for tokens
// issued before `sid` existed — callers fall back rather than fail.
function findByUid(uid) {
  return uid ? sessionRepo.findOne({ uid }) : Promise.resolve(null);
}

module.exports = { revokeSession, revokeOthers, revokeAll, liveSessions, findByUid };
