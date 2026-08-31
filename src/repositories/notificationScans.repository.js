const { QueryTypes } = require('sequelize');
const sequelize = require('../config/db');

// The candidate queries behind the behavioural and date-anchored scans.
//
// TWO RULES SHAPE EVERY QUERY HERE.
//
// 1. ANCHOR ON A NARROW SLICE OF AN INDEXED TIMESTAMP, then use the state as a
//    residual filter. The naive "everyone inactive for 7+ days" is open-ended:
//    it makes the candidate set the entire dormant population every single night,
//    virtually all of which is then discarded. A three-day bucket
//    [now-10d, now-7d) is a range scan over three daily cohorts instead.
//
//    A second, bigger benefit: on the FIRST run after deploy it does not blast the
//    entire back-catalogue of long-dormant users with "we miss you", because
//    someone last seen 200 days ago does not fall in the bucket. That property is
//    worth more than the query cost.
//
// 2. USE A RANGE, NEVER AN EQUALITY. `DATE(x) = :threeDaysAgo` loses a whole
//    cohort permanently if a run is missed. The three-day width self-heals across
//    two skipped nights — and it is free, because the dedupe key is anchored on
//    frozen state (not the run date), so nights two and three collide and are
//    ignored. The range gives self-healing; the dedupe key makes the range safe.
//    Neither decision works without the other.
//
// Raw SQL because these are EXISTS/anti-join shapes that Sequelize expresses badly,
// and because the scans are the one place where the query plan actually matters.
// Every value is bound; nothing is interpolated.

// Keyset, always — OFFSET over a large users table degrades with every page.
const PAGE = `
        AND u.id > :cursor
      ORDER BY u.id
      LIMIT :limit`;

const run = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/**
 * Users whose last activity falls in [now-(days+window), now-days).
 *
 * `anchor` is DATE(last_active_at) — frozen while they stay away, and it jumps the
 * moment they return. That is what lets the same user be notified again after a
 * later lapse while a nightly re-scan of the same lapse inserts nothing.
 */
function inactive({ days, windowDays = 3, cursor = 0, limit = 500 }) {
  return run(
    `SELECT u.id AS user_id,
            DATE(COALESCE(u.last_active_at, u.created_at)) AS anchor
       FROM users u
      WHERE u.is_active = 1
        AND COALESCE(u.last_active_at, u.created_at) >= DATE_SUB(NOW(), INTERVAL :lo DAY)
        AND COALESCE(u.last_active_at, u.created_at) <  DATE_SUB(NOW(), INTERVAL :days DAY)
        ${PAGE}`,
    { lo: days + windowDays, days, cursor, limit },
  );
}

/**
 * Signed up, never came back. Distinguished from `inactive` by last activity
 * still sitting within an hour of signup — they got a token and vanished.
 */
function neverReturned({ days = 3, windowDays = 3, cursor = 0, limit = 500 }) {
  return run(
    `SELECT u.id AS user_id, DATE(u.created_at) AS anchor
       FROM users u
      WHERE u.is_active = 1
        AND u.created_at >= DATE_SUB(NOW(), INTERVAL :lo DAY)
        AND u.created_at <  DATE_SUB(NOW(), INTERVAL :days DAY)
        AND TIMESTAMPDIFF(MINUTE, u.created_at, COALESCE(u.last_active_at, u.created_at)) < 60
        ${PAGE}`,
    { lo: days + windowDays, days, cursor, limit },
  );
}

/** Signed up but never finished the personalisation flow. */
function onboardingIncomplete({ minDays = 1, maxDays = 7, cursor = 0, limit = 500 }) {
  return run(
    `SELECT u.id AS user_id, DATE(u.created_at) AS anchor
       FROM users u
      WHERE u.is_active = 1
        AND u.onboarding_completed_at IS NULL
        AND u.created_at >= DATE_SUB(NOW(), INTERVAL :maxDays DAY)
        AND u.created_at <  DATE_SUB(NOW(), INTERVAL :minDays DAY)
        ${PAGE}`,
    { minDays, maxDays, cursor, limit },
  );
}

/** Finished onboarding, never made anything. */
function noProjects({ minDays = 1, maxDays = 4, cursor = 0, limit = 500 }) {
  return run(
    `SELECT u.id AS user_id, DATE(u.created_at) AS anchor
       FROM users u
      WHERE u.is_active = 1
        AND u.onboarding_completed_at IS NOT NULL
        AND u.created_at >= DATE_SUB(NOW(), INTERVAL :maxDays DAY)
        AND u.created_at <  DATE_SUB(NOW(), INTERVAL :minDays DAY)
        AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id)
        ${PAGE}`,
    { minDays, maxDays, cursor, limit },
  );
}

/** A personal account that has not created a business. */
function noBusinessProfile({ minDays = 3, maxDays = 7, cursor = 0, limit = 500 }) {
  return run(
    `SELECT u.id AS user_id, DATE(u.created_at) AS anchor
       FROM users u
      WHERE u.is_active = 1
        AND u.account_type = 'personal'
        AND u.created_at >= DATE_SUB(NOW(), INTERVAL :maxDays DAY)
        AND u.created_at <  DATE_SUB(NOW(), INTERVAL :minDays DAY)
        AND NOT EXISTS (SELECT 1 FROM businesses b WHERE b.user_id = u.id AND b.is_active = 1)
        ${PAGE}`,
    { minDays, maxDays, cursor, limit },
  );
}

/**
 * Still on a personal account long after signup — the recurring "ready to promote
 * your business?" nudge.
 *
 * Anchored on signup age rather than a date bucket, because the cadence is "every
 * N days forever" rather than a one-off window. The dedupe key uses the cycle
 * bucket (floor(age / N)), so it fires at most once per cycle without storing a
 * counter, and `max_occurrences` on the template is what eventually stops it.
 */
function stillPersonal({ minDays = 12, cursor = 0, limit = 500 }) {
  return run(
    `SELECT u.id AS user_id, u.created_at AS anchor
       FROM users u
      WHERE u.is_active = 1
        AND u.account_type = 'personal'
        AND u.created_at < DATE_SUB(NOW(), INTERVAL :minDays DAY)
        AND NOT EXISTS (SELECT 1 FROM businesses b WHERE b.user_id = u.id AND b.is_active = 1)
        ${PAGE}`,
    { minDays, cursor, limit },
  );
}

// --- business setup gaps ----------------------------------------------------
//
// All five share one shape: a narrow slice of businesses.created_at (indexed by
// ix_businesses_created), with the missing-thing test as a residual filter on the
// already-small slice. Deliberately NOT indexing logo_s3_key and friends — the
// slice is tiny and a VARCHAR(500) index would cost far more than it saves.

const BUSINESS_GAPS = {
  no_logo:           'b.logo_s3_key IS NULL',
  no_active_frame:   'b.active_frame_id IS NULL',
  business_incomplete: '(b.category_id IS NULL OR b.description IS NULL OR b.description = \'\')',
  no_products:       'NOT EXISTS (SELECT 1 FROM products p WHERE p.business_id = b.id)',
  no_business_tags:  'NOT EXISTS (SELECT 1 FROM business_tags bt WHERE bt.business_id = b.id)',
};

/**
 * @param {string} gap one of BUSINESS_GAPS
 *
 * `anchor` is the business id plus the cycle bucket, so a nag repeats on the
 * template's own cadence rather than once ever — the owner may well add a logo
 * three weeks later.
 */
function businessGap({ gap, minDays = 1, maxDays = 4, cursor = 0, limit = 500 }) {
  const predicate = BUSINESS_GAPS[gap];
  if (!predicate) throw new Error(`Unknown business gap predicate '${gap}'`);

  return run(
    `SELECT u.id AS user_id, b.id AS business_id, b.created_at AS anchor
       FROM businesses b
       JOIN users u ON u.id = b.user_id AND u.is_active = 1
      WHERE b.is_active = 1
        AND b.created_at >= DATE_SUB(NOW(), INTERVAL :maxDays DAY)
        AND b.created_at <  DATE_SUB(NOW(), INTERVAL :minDays DAY)
        AND ${predicate}
        ${PAGE}`,
    { minDays, maxDays, cursor, limit },
  );
}

// --- date-anchored ----------------------------------------------------------

/**
 * Subscriptions whose end date falls `offsetDays` from now, within a window.
 *
 * The dedupe key is the subscription id PLUS its ends_at date, so a renewal that
 * pushes ends_at out earns a fresh warning next term rather than being suppressed
 * by the one sent for the previous term.
 */
function subscriptionsEnding({ offsetDays, windowDays = 1, subType = 'regular', cursor = 0, limit = 500 }) {
  return run(
    `SELECT s.user_id AS user_id, s.id AS subscription_id,
            DATE(s.ends_at) AS anchor, p.name AS plan_name
       FROM user_subscriptions s
       JOIN users u ON u.id = s.user_id AND u.is_active = 1
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.status = 'active'
        AND s.sub_type = :subType
        AND s.ends_at >= DATE_ADD(NOW(), INTERVAL :lo DAY)
        AND s.ends_at <  DATE_ADD(NOW(), INTERVAL :hi DAY)
        AND s.id > :cursor
      ORDER BY s.id
      LIMIT :limit`,
    { subType, lo: offsetDays - windowDays, hi: offsetDays, cursor, limit },
  );
}

/**
 * Special events occurring on a given IST date.
 *
 * Two ways an event can land on a day: `event_date` is an annually recurring
 * 'MM-DD', `full_date` is a one-off. Mirrors the resolution in
 * specialEvent.service#listSpecialEvents.
 */
function eventsOn({ dateISO, types = null }) {
  const mmdd = dateISO.slice(5);
  return run(
    `SELECT e.id AS event_id, e.name AS event_name
       FROM special_events e
      WHERE e.is_active = 1
        AND (e.event_date = :mmdd OR e.full_date = :dateISO)
        ${types ? 'AND e.type IN (:types)' : ''}
      ORDER BY e.id`,
    types ? { mmdd, dateISO, types } : { mmdd, dateISO },
  );
}

/** Every active user, for a recurring blast or an event-day fan-out. */
function activeUsers({ accountType = null, cursor = 0, limit = 500 }) {
  return run(
    `SELECT u.id AS user_id
       FROM users u
      WHERE u.is_active = 1
        ${accountType ? 'AND u.account_type = :accountType' : ''}
        ${PAGE}`,
    accountType ? { accountType, cursor, limit } : { cursor, limit },
  );
}

module.exports = {
  inactive,
  neverReturned,
  onboardingIncomplete,
  noProjects,
  noBusinessProfile,
  stillPersonal,
  businessGap,
  subscriptionsEnding,
  eventsOn,
  activeUsers,
  BUSINESS_GAPS,
};
