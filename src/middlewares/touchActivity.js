const { User } = require('../models');

// Keeps `users.last_active_at` roughly current. Every retention notification is
// keyed on it.
//
// Called from the tail of `authenticate` rather than mounted as its own middleware:
// req.user does not exist until authenticate has run, so a global mount would see
// nothing, and mounting it on each of the eight user-facing routers means the next
// router someone adds silently stops counting as activity. One call site, with the
// admin guard below, is the version that cannot rot.
//
// THROTTLED, not per-request. Writing on every authenticated call would make the
// most-joined table in the schema the hottest write in the API, and each UPDATE
// contends with the SELECTs against the same rows — all to gain minutes of
// precision on thresholds measured in DAYS. A 15-minute window costs one or two
// writes per user per session instead. It is also fire-and-forget: the caller does
// not await it, so it never sits on the response path.
//
// Rejected alternatives: deriving from `user_sessions` (that records LOGIN, and a
// refresh token lives 30 days, so a daily-active user would look dormant); from
// `activity_logs` (written only for specific mutations, so a browsing user looks
// dormant, and it is pruned); Redis (optional in this deployment, so the in-memory
// path has to exist anyway — Redis can slot in behind `shouldWrite` later without
// changing anything else).
const WINDOW_MS   = 15 * 60 * 1000;
const MAX_TRACKED = 50000;

const seen = new Map();   // userId -> last write, ms

function shouldWrite(userId, now) {
  const last = seen.get(userId);
  if (last && now - last < WINDOW_MS) return false;

  // Crude bound. Clearing degrades to more writes, never to wrong data — and the
  // alternative (an LRU) is machinery for a map holding one integer per recently
  // active user.
  if (seen.size >= MAX_TRACKED) seen.clear();
  seen.set(userId, now);
  return true;
}

/**
 * Stamps last_active_at if the throttle window has elapsed. Never throws, never
 * awaited.
 */
function touchActivity(reqUser) {
  const userId = reqUser?.userId;
  // Admins are excluded: an admin browsing the panel is not app activity, and
  // their ids index a different table entirely.
  if (!userId || reqUser.actor_type !== 'user') return;

  const now = Date.now();
  if (!shouldWrite(userId, now)) return;

  User.update({ last_active_at: new Date(now) }, { where: { id: userId } })
    .catch((err) => console.error('[touchActivity]', err.message));
}

// Exposed so tests can reset the throttle between cases.
touchActivity._reset = () => seen.clear();

module.exports = touchActivity;
