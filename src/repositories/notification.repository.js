const { QueryTypes } = require('sequelize');
const sequelize = require('../config/db');

// Set-wise reads for the notification engine.
//
// Everything here takes a LIST of user ids and answers for all of them in one
// query. That is the whole point: a campaign chunk is 500 users, and a per-user
// round trip for "are they eligible" plus another for "are they fatigued" would be
// 1000 queries per chunk. The single-send path passes an array of one and uses the
// same code, so the two paths cannot drift apart in their rules.
//
// Raw SQL rather than Sequelize includes because these are aggregate + EXISTS
// shapes that the ORM expresses badly (and, for the anti-join in the scans, not at
// all cleanly). Every value is bound as a replacement; nothing is interpolated.

/**
 * Everything the audience and consent gates need, for a set of users at once.
 *
 * Returns one row per user id that exists and is active:
 *   { user_id, account_type, onboarding_completed_at, created_at, last_active_at,
 *     is_paid, is_trial, has_business, notify_marketing, category_muted }
 *
 * `category_muted` is resolved here rather than in a second query because the mute
 * is per (user, category) and the category is fixed for one dispatch — so it joins
 * cleanly and costs nothing extra.
 */
async function eligibilityFacts(userIds, categoryId = null) {
  if (!userIds.length) return [];

  return sequelize.query(
    `SELECT u.id                                   AS user_id,
            u.account_type                         AS account_type,
            u.onboarding_completed_at              AS onboarding_completed_at,
            u.created_at                           AS created_at,
            u.last_active_at                       AS last_active_at,
            EXISTS (SELECT 1 FROM user_subscriptions s
                     WHERE s.user_id = u.id AND s.status = 'active')            AS is_paid,
            EXISTS (SELECT 1 FROM user_subscriptions s
                     WHERE s.user_id = u.id AND s.status = 'active'
                       AND s.sub_type = 'trial')                                AS is_trial,
            EXISTS (SELECT 1 FROM businesses b
                     WHERE b.user_id = u.id AND b.is_active = 1)                AS has_business,
            -- The row is created lazily, so absent means "default on" — the same
            -- convention user.service#getPreferences applies.
            COALESCE(p.notify_marketing, 1)                                     AS notify_marketing,
            -- Likewise: a settings row exists only when the user turned something
            -- OFF, so absent means not muted.
            CASE WHEN :categoryId IS NULL THEN 0
                 ELSE COALESCE((SELECT 1 - ns.in_app
                                  FROM user_notification_settings ns
                                 WHERE ns.user_id = u.id
                                   AND ns.category_id = :categoryId), 0)
            END                                                                 AS category_muted
       FROM users u
       LEFT JOIN user_preferences p ON p.user_id = u.id
      WHERE u.id IN (:userIds)
        AND u.is_active = 1`,
    { replacements: { userIds, categoryId }, type: QueryTypes.SELECT },
  );
}

/**
 * The fatigue windows for a set of users: how many PROMOTIONAL notifications they
 * have had today and this week, and when the most recent one landed.
 *
 * Transactional rows are excluded from the count, not just from the cap — a burst
 * of payment receipts must not consume the allowance for a nudge, and vice versa.
 * Served by ix_user_notif_fatigue (user_id, is_promotional, created_at).
 */
async function fatigueFacts(userIds, dayStart, weekStart) {
  if (!userIds.length) return [];

  return sequelize.query(
    `SELECT user_id,
            SUM(created_at >= :dayStart) AS day_count,
            COUNT(*)                     AS week_count,
            MAX(created_at)              AS last_at
       FROM user_notifications
      WHERE user_id IN (:userIds)
        AND is_promotional = 1
        AND created_at >= :weekStart
      GROUP BY user_id`,
    { replacements: { userIds, dayStart, weekStart }, type: QueryTypes.SELECT },
  );
}

/**
 * Per-template history for a set of users — drives `cooldown_hours` and
 * `max_occurrences`.
 *
 * Kept as its own query rather than OR-ed into the one above: the OR between "any
 * promo in the last 7 days" and "this template, ever" defeats both indexes, where
 * two clean range scans use ix_user_notif_fatigue and ix_user_notif_cooldown
 * respectively.
 *
 * NOTE: `max_occurrences` therefore counts occurrences still inside the retention
 * window (see jobs/notificationCleanup.job.js). That is the documented behaviour,
 * not a bug — a lifetime cap on a row we deleted a year ago is unenforceable
 * without keeping a counter that could itself drift.
 */
async function templateHistory(userIds, templateId) {
  if (!userIds.length || !templateId) return [];

  return sequelize.query(
    `SELECT user_id, COUNT(*) AS total, MAX(created_at) AS last_at
       FROM user_notifications
      WHERE user_id IN (:userIds) AND template_id = :templateId
      GROUP BY user_id`,
    { replacements: { userIds, templateId }, type: QueryTypes.SELECT },
  );
}

/**
 * How many of these exact (user_id, dedupe_key) pairs already exist.
 *
 * Used to report how many rows a batch actually landed. The obvious alternative —
 * counting rows with `created_at >= now` after the insert — is unsound: Sequelize's
 * DATE maps to MySQL DATETIME with no fractional seconds, so `created_at` is
 * truncated DOWN to the whole second and compares as EARLIER than the JavaScript
 * timestamp taken moments before. That readback would report zero every time.
 *
 * A tuple IN is also exact where two separate `user_id IN (...) AND dedupe_key IN
 * (...)` lists are not: those form a cross product and would count a pre-existing
 * (userA, keyB) row that this batch never proposed.
 *
 * MySQL resolves a row-constructor IN against uq_user_notif_dedupe as one index
 * lookup per pair, so this is the same cost the insert itself pays.
 */
async function countExistingKeys(pairs) {
  if (!pairs.length) return 0;

  const tuples = pairs.map(() => '(?, ?)').join(', ');
  const flat   = pairs.flatMap((p) => [p.user_id, p.dedupe_key]);

  const [row] = await sequelize.query(
    `SELECT COUNT(*) AS total
       FROM user_notifications
      WHERE (user_id, dedupe_key) IN (${tuples})`,
    { replacements: flat, type: QueryTypes.SELECT },
  );
  return Number(row.total);
}

module.exports = { eligibilityFacts, fatigueFacts, templateHistory, countExistingKeys };
