// Clock math in the product's timezone.
//
// MMB is India-only — otpHelper.toLocalNumber enforces Indian 10-digit numbers —
// and `users` deliberately has no timezone column. So there is exactly one local
// clock, and every "is it too late to notify this person", "which day is this",
// and "which week is this" question resolves against it.
//
// IST has no DST, so this is a fixed offset and not something Intl needs to be
// consulted about per row. The offset comes from config so a test can move it, but
// it is not expected to change.
//
// The trick throughout: shift the instant by the offset, then read the UTC fields.
// That gives IST calendar fields without touching the process's local timezone,
// which on a server is usually UTC and on a developer's laptop is anything.
const cfg = require('../config/notifications');

const MINUTE = 60 * 1000;
const DAY    = 24 * 60 * MINUTE;

// Callers hand these helpers timestamps from three different worlds: JS Dates,
// ISO strings from JSON, and MySQL DATETIME strings straight off a raw query
// (quota.service#currentWindow returns the last kind). Coercing here rather than
// at every call site is the difference between one conversion and a `getTime is
// not a function` in whichever path was not thought about.
const toDate = (value) => (value instanceof Date ? value : new Date(value));

// A Date whose UTC fields read as the IST wall clock. Never send this to the DB —
// it is a display/comparison shim, not a real instant.
function shifted(date = new Date()) {
  const d = toDate(date);
  if (Number.isNaN(d.getTime())) {
    // Loud: an unparseable timestamp reaching a dedupe key would silently produce
    // 'inactive_7d:la:invalid date' for EVERY user, collapsing them onto one key.
    throw new TypeError(`istTime: cannot interpret ${JSON.stringify(date)} as a date`);
  }
  return new Date(d.getTime() + cfg.tzOffsetMinutes() * MINUTE);
}

// IST calendar date as 'YYYY-MM-DD'.
//
// This is the anchor for every dormancy dedupe key, so it must be stable while a
// condition holds: DATE(last_active_at) does not move while a user stays away, and
// jumps the moment they return. That is the whole reason the nightly scans need no
// episode bookkeeping.
const istDateISO = (date = new Date()) => shifted(date).toISOString().slice(0, 10);

// IST wall-clock hour, 0-23.
const istHour = (date = new Date()) => shifted(date).getUTCHours();

// ISO-8601 week as 'YYYY-Www' — the dedupe token for anything cadenced "weekly".
// ISO weeks start Monday and belong to the year containing their Thursday, which
// is what stops a send at the turn of the year from firing twice.
function istIsoWeek(date = new Date()) {
  const d = shifted(date);
  d.setUTCHours(0, 0, 0, 0);
  // Move to the Thursday of this week: that day's year is the ISO week-year.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// IST calendar month as 'YYYY-MM'.
const istMonth = (date = new Date()) => istDateISO(date).slice(0, 7);

// Whole days between two instants, on the IST calendar rather than by elapsed
// milliseconds — "2 days ago" must mean two date boundaries, not 48 hours.
function istDaysBetween(from, to = new Date()) {
  const a = Date.parse(`${istDateISO(from)}T00:00:00Z`);
  const b = Date.parse(`${istDateISO(to)}T00:00:00Z`);
  return Math.round((b - a) / DAY);
}

// Is this instant inside the quiet window? The window wraps midnight (21:00 ->
// 09:00), so the comparison flips depending on whether start < end.
function isQuietHour(date = new Date()) {
  const h     = istHour(date);
  const start = cfg.quietStartHour();
  const end   = cfg.quietEndHour();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

/**
 * When may a non-urgent notification decided at `date` actually be shown?
 *
 * Returns `date` itself outside quiet hours, otherwise the next quiet-window end.
 * The row is still INSERTED at decision time with this as its deliver_at — see
 * userNotification.model.js — so a retry of the same trigger collides on the
 * dedupe key instead of queueing a second copy.
 */
function nextDeliverableAt(date = new Date()) {
  if (!isQuietHour(date)) return date;

  const end = cfg.quietEndHour();
  const s   = shifted(date);
  // Today's window end in IST wall-clock terms...
  const target = new Date(s);
  target.setUTCHours(end, 0, 0, 0);
  // ...rolled to tomorrow if we are past it (i.e. in the late-evening half of a
  // window that wraps midnight).
  if (target <= s) target.setUTCDate(target.getUTCDate() + 1);

  // Shift back out of IST into a real instant.
  return new Date(target.getTime() - cfg.tzOffsetMinutes() * MINUTE);
}

/**
 * `new Date()` truncated to a whole second.
 *
 * Sequelize's DATE maps to MySQL DATETIME, which has no fractional part — so a
 * timestamp written with milliseconds comes back without them. Anything that
 * writes a state timestamp AND returns it in the same response must use this, or
 * the value the client gets differs from the value that was stored (and from what
 * it will read next time), purely depending on whether it just wrote it.
 */
const nowSecond = () => new Date(Math.floor(Date.now() / 1000) * 1000);

module.exports = {
  nowSecond,
  istDateISO,
  istHour,
  istIsoWeek,
  istMonth,
  istDaysBetween,
  isQuietHour,
  nextDeliverableAt,
};
