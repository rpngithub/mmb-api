// Builders for `user_notifications.dedupe_key`.
//
// THE RULE: a dedupe key identifies the OCCASION, never the notification and never
// the run. It must be derived from state that is FROZEN while the condition holds
// and that MOVES when the condition breaks.
//
//   Keyed on NOW()/today        -> re-fires every single day the condition holds.
//   Keyed on the template alone -> never fires again, even years later.
//   Keyed on the frozen state   -> fires exactly once per episode. Correct.
//
// For dormancy that frozen state is DATE(last_active_at): it does not move while
// the user stays away, so every nightly re-scan produces the identical key and is
// ignored by UNIQUE (user_id, dedupe_key); the moment they return it jumps, and
// their next lapse produces a new key and a new notification. No episode table, no
// state machine.
//
// Two shapes carry almost everything:
//
//   episode anchor  `:sub:412:2026-09-14`, `:la:2026-08-22`
//                   once per subscription term / dormancy episode
//   cycle bucket    `:c7`  = floor(age_days / N)
//                   at most once per N-day window, counter derived not stored
//
// Keys are kept READABLE rather than hashed. The first production question will be
// "why did this user get three of these", and a SELECT should answer it.
const { istDateISO, istIsoWeek, istMonth, istDaysBetween } = require('./istTime');

// The column is VARCHAR(191) and the unique index depends on it fitting; a
// truncated key would silently collide with a different occasion.
const MAX_LEN = 191;

/**
 * `key('inactive_7d', 'la', '2026-08-22')` -> `'inactive_7d:la:2026-08-22'`
 *
 * Empty/nullish parts are dropped rather than producing a `::`, so a caller that
 * omits an optional scope still gets a stable key instead of two different ones.
 */
function key(code, ...parts) {
  const out = [code, ...parts]
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join(':')
    .toLowerCase();

  if (out.length > MAX_LEN) {
    // Loud, because silently truncating merges two distinct occasions into one and
    // the second notification would never be sent.
    throw new Error(`dedupe_key too long (${out.length} > ${MAX_LEN}): ${out}`);
  }
  return out;
}

// --- the standard shapes -----------------------------------------------------

// Once, ever, for this user. 'welcome', 'first_design_created'.
const once = (code) => key(code);

// Tied to one row of another table: a payment, a subscription, a special event.
// Use when that row's identity IS the occasion.
const forEntity = (code, entity, id) => key(code, entity, id);

// Tied to a row AND a date on it — so it re-fires when the date moves. A renewal
// that pushes `ends_at` out legitimately earns a fresh "expiring soon".
const forEntityDate = (code, entity, id, date) => key(code, entity, id, istDateISO(date));

// The dormancy shape. `lastActiveAt` is frozen for the whole episode.
const forDormancy = (code, lastActiveAt) => key(code, 'la', istDateISO(lastActiveAt));

// The recurring shapes.
const forWeek  = (code, date) => key(code, istIsoWeek(date));
const forMonth = (code, date) => key(code, istMonth(date));

// The billing-window shape: one per period, not one per spend. `credits_low` must
// nag once a cycle, not on every AI call after the threshold.
const forPeriod = (code, periodStart) => key(code, istDateISO(periodStart));

/**
 * The cycle bucket: at most once per `days`, counted from `since`.
 *
 * `forCycle('start_business_journey', signupDate, 12)` yields `...:c0`, then `:c1`
 * twelve days later, and so on. The counter is derived from two dates, so nothing
 * has to be stored and a missed run simply lands in the same bucket and is ignored
 * rather than shifting the whole schedule.
 */
function forCycle(code, since, days, now = new Date()) {
  const age = Math.max(0, istDaysBetween(since, now));
  return key(code, `c${Math.floor(age / days)}`);
}

// A campaign reaches each user exactly once. Deliberately NOT chunk-scoped: chunk
// boundaries shift when the segment result set changes between runs, and a
// chunk-scoped key would let a shifted boundary double-send.
const forCampaign = (campaignId) => key('campaign', campaignId);

module.exports = {
  key,
  once,
  forEntity,
  forEntityDate,
  forDormancy,
  forWeek,
  forMonth,
  forPeriod,
  forCycle,
  forCampaign,
  MAX_LEN,
};
