const { Op }          = require('sequelize');
const { Business, BusinessVariant } = require('../models');
const quota           = require('./quota.service');
const userSubRepo     = require('../repositories/userSubscription.repository');
const { heldVariantCount } = require('../constants/quotaMeters');

// The Brand Series quota, as option B uses it (see variantAccess.service): how many
// variants a subscriber may have ADDED to their business at a time. Counted live from
// business_variants (a gauge), so removing a variant frees its slot.
//
// Kept apart from business.service so the three places that need it — adding, the
// purchase rule, and the downgrade trim at activation — share one definition of
// "full" without subscription.service having to load the business layer.

const FEATURE = 'brand_series';

// Where the user stands. `limit` / `remaining` are null when unlimited (the plan
// declares no limit, or enforcement is relaxed). Without an active subscription the
// user can add nothing at all, whatever the free plan says: `full` is then
// meaningless and `subscribed` is what callers branch on.
async function state(userId) {
  const sub = await userSubRepo.findActiveByUser(userId);
  if (!sub) return { subscribed: false, limit: null, used: await heldVariantCount(userId), remaining: null, full: false };

  const snap = await quota.snapshot(userId, FEATURE);
  return {
    subscribed: true,
    limit:      snap.limit,
    used:       snap.used,
    remaining:  snap.remaining,
    full:       snap.remaining !== null && snap.remaining <= 0,
  };
}

// Downgrade rule (decided 2026-10-28): keep the MOST RECENTLY added variants up to the
// current plan's limit and remove the rest. Run when a subscription activates — a
// smaller plan takes effect, or a lapsed user subscribes again. Removing frees slots,
// so it is never a quota event. Returns how many rows went.
async function trimToQuota(userId) {
  const limit = await quota.limitFor(userId, FEATURE);
  if (limit === null) return 0;

  const businesses = await Business.findAll({ where: { user_id: userId }, attributes: ['id'] });
  if (!businesses.length) return 0;

  const rows = await BusinessVariant.findAll({
    where: { business_id: { [Op.in]: businesses.map((b) => b.id) } },
    attributes: ['id', 'variant_id'],
    order: [['created_at', 'DESC'], ['id', 'DESC']],
  });

  // A variant added to two businesses is one slot; its rows stay or go together.
  const keep = new Set();
  for (const r of rows) {
    if (keep.size >= limit) break;
    keep.add(r.variant_id);
  }
  const drop = rows.filter((r) => !keep.has(r.variant_id)).map((r) => r.id);
  if (drop.length) await BusinessVariant.destroy({ where: { id: { [Op.in]: drop } } });
  return drop.length;
}

module.exports = { FEATURE, state, trimToQuota };
