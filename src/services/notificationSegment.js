const { QueryTypes } = require('sequelize');
const sequelize = require('../config/db');
const { ValidationError } = require('../errors');

// Turns a campaign's `audience` JSON into SQL.
//
// ONE skeleton, TWO projections: the preview COUNT the admin approves and the
// page the fan-out actually sends to are the same FROM and the same WHERE, built
// by the same code. If those ever became separate queries they would drift, and
// the drift would be discovered by an admin who sent to three times the audience
// they were shown.
//
// SAFETY: the filter object comes from an admin-authored JSON column, so it is
// treated as untrusted input. Every key must be in HANDLERS — an unknown one
// throws rather than being ignored, because a silently-dropped filter widens the
// audience instead of narrowing it, which is the dangerous direction. Every value
// is a bind parameter; nothing is interpolated into the SQL string.

// Marketing consent is ANDed unconditionally below, not as an optional filter.
// `user_preferences`' own migration comment requires it: a campaign must never be
// able to reach someone who only opted into receipts.

const HANDLERS = {
  account_type: (v) => (v === 'all' ? null : { sql: 'u.account_type = :account_type', params: { account_type: v } }),

  plan: (v) => {
    if (v === 'all') return null;
    const active = "EXISTS (SELECT 1 FROM user_subscriptions s WHERE s.user_id = u.id AND s.status = 'active'";
    if (v === 'free')  return { sql: `NOT ${active})`, params: {} };
    if (v === 'paid')  return { sql: `${active})`, params: {} };
    if (v === 'trial') return { sql: `${active} AND s.sub_type = 'trial')`, params: {} };
    return null;
  },

  has_business: (v) => ({
    sql: `${v ? '' : 'NOT '}EXISTS (SELECT 1 FROM businesses b WHERE b.user_id = u.id AND b.is_active = 1)`,
    params: {},
  }),

  industry_ids: (v) => (v.length ? {
    sql: `EXISTS (SELECT 1 FROM businesses b
                   WHERE b.user_id = u.id AND b.is_active = 1
                     AND b.category_id IN (:industry_ids))`,
    params: { industry_ids: v },
  } : null),

  onboarding: (v) => ({
    sql: v === 'complete' ? 'u.onboarding_completed_at IS NOT NULL' : 'u.onboarding_completed_at IS NULL',
    params: {},
  }),

  // Dormancy as a RANGE the admin controls. COALESCE because last_active_at is
  // nullable for anyone who has not been seen since the column was added.
  inactive_days_min: (v) => ({
    sql: 'COALESCE(u.last_active_at, u.created_at) <= DATE_SUB(NOW(), INTERVAL :inactive_days_min DAY)',
    params: { inactive_days_min: v },
  }),
  inactive_days_max: (v) => ({
    sql: 'COALESCE(u.last_active_at, u.created_at) >= DATE_SUB(NOW(), INTERVAL :inactive_days_max DAY)',
    params: { inactive_days_max: v },
  }),

  signed_up_after:  (v) => ({ sql: 'u.created_at >= :signed_up_after',  params: { signed_up_after: v } }),
  signed_up_before: (v) => ({ sql: 'u.created_at <= :signed_up_before', params: { signed_up_before: v } }),

  cities: (v) => (v.length ? {
    sql: `EXISTS (SELECT 1 FROM businesses b
                   WHERE b.user_id = u.id AND b.is_active = 1 AND b.city IN (:cities))`,
    params: { cities: v },
  } : null),

  // An explicit list wins as an additional narrowing clause rather than replacing
  // the others, so "these 40 users, but only the ones on free" behaves as read.
  user_uids: (v) => (v.length ? { sql: 'u.uid IN (:user_uids)', params: { user_uids: v } } : null),
};

/**
 * Builds the shared WHERE.
 *
 * @param {object} audience the campaign's stored filter object
 * @param {object} [opts]
 * @param {boolean} [opts.requireMarketingConsent=true] campaigns always require it;
 *        only an is_promotional=0 system announcement would ever pass false, and
 *        nothing does today.
 */
function buildWhere(audience = {}, { requireMarketingConsent = true } = {}) {
  const clauses = ['u.is_active = 1'];
  const params  = {};

  if (requireMarketingConsent) {
    // COALESCE: the preferences row is created lazily, and absent means opted in.
    clauses.push('COALESCE(p.notify_marketing, 1) = 1');
  }

  for (const [k, v] of Object.entries(audience || {})) {
    if (v === undefined || v === null) continue;

    const handler = HANDLERS[k];
    if (!handler) {
      throw new ValidationError(
        `Unknown audience filter '${k}'. Allowed: ${Object.keys(HANDLERS).join(', ')}`,
      );
    }

    const built = handler(v);
    if (!built) continue;
    clauses.push(built.sql);
    Object.assign(params, built.params);
  }

  return { where: clauses.join('\n        AND '), params };
}

const SKELETON = `
    FROM users u
    LEFT JOIN user_preferences p ON p.user_id = u.id
   WHERE `;

/** How many users this segment reaches right now. */
async function countAudience(audience, opts) {
  const { where, params } = buildWhere(audience, opts);
  const [row] = await sequelize.query(
    `SELECT COUNT(*) AS total ${SKELETON} ${where}`,
    { replacements: params, type: QueryTypes.SELECT },
  );
  return Number(row.total);
}

/**
 * One keyset page of the segment.
 *
 * `u.id > :afterId ORDER BY u.id` rather than OFFSET: the campaign's stored
 * cursor is a user id, so a resumed fan-out picks up exactly where it stopped even
 * though the underlying set may have changed between ticks.
 */
async function selectUsers(audience, { afterId = 0, limit = 500 } = {}, opts) {
  const { where, params } = buildWhere(audience, opts);
  return sequelize.query(
    `SELECT u.id ${SKELETON} ${where}
        AND u.id > :afterId
     ORDER BY u.id
     LIMIT :limit`,
    { replacements: { ...params, afterId, limit }, type: QueryTypes.SELECT },
  );
}

/** A handful of real users, so the admin can see who this would actually hit. */
async function sampleUsers(audience, limit = 5, opts) {
  const { where, params } = buildWhere(audience, opts);
  return sequelize.query(
    `SELECT u.uid, u.name, u.account_type ${SKELETON} ${where}
     ORDER BY u.id DESC
     LIMIT :limit`,
    { replacements: { ...params, limit }, type: QueryTypes.SELECT },
  );
}

module.exports = { buildWhere, countAudience, selectUsers, sampleUsers, HANDLERS };
