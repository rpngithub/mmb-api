const planFeatureRepo = require('../repositories/planFeature.repository');
const userSubRepo     = require('../repositories/userSubscription.repository');
const quotaRepo       = require('../repositories/userQuotaUsage.repository');
const { QuotaError }  = require('../errors');

// Maps a plan-feature key to its counter column on user_quota_usage.
// `storage` MUST be listed: without it the fallback below produced
// `storage_count`, a column that does not exist, so every storage read came back
// undefined -> 0 and the limit could never be reached.
const FIELD = {
  downloads:      'downloads_count',
  shares:         'shares_count',
  template_views: 'template_views_count',
  ai_credits:     'ai_credits_used',
  storage:        'storage_used_bytes',
};

// plan_features.value is an INTEGER and storage is expressed there in MEGABYTES
// (the feature_type label says "Storage (MB)"; the seed uses 100), while the
// counter is in BYTES. Everything else is a plain count, scale 1. Without this
// the two units were compared directly, so a 100 MB plan read as a 100 BYTE one.
//
// Storage stays in MB in plan_features on purpose: the column is a signed INT, so
// a byte-valued limit would overflow just past 2 GB.
const LIMIT_SCALE = { storage: 1024 * 1024 };

const fieldFor = (featureKey) => FIELD[featureKey] || `${featureKey}_count`;
const scaleFor = (featureKey) => LIMIT_SCALE[featureKey] || 1;

// The limit in the same unit as the counter, or null for unlimited/unset.
async function limitFor(userId, featureKey) {
  const sub = await userSubRepo.findActiveByUser(userId);
  // Users without an active subscription are not enforced. This is the
  // pre-existing free-tier behaviour and is a deliberate open decision, NOT an
  // oversight — see the free-tier quota question. Usage is still RECORDED for
  // them below, so switching enforcement on later needs no backfill.
  if (!sub) return null;

  const value = await planFeatureRepo.getFeatureValue(sub.plan_id, featureKey);
  if (value === null || value === -1) return null;   // unset / unlimited
  return value * scaleFor(featureKey);
}

// Throws QuotaError when consuming `by` more would take the user past their plan
// limit for `featureKey`. `by` is in counter units (bytes for storage, 1 per
// action for the counters), so a single call covers "may I upload 4 MB?" and
// "may I download once?".
async function assertWithinQuota(userId, featureKey, by = 1) {
  const limit = await limitFor(userId, featureKey);
  if (limit === null) return;

  const usage = await quotaRepo.findByUserId(userId);
  const used  = usage ? Number(usage[fieldFor(featureKey)] ?? 0) : 0;
  if (used + by > limit) throw new QuotaError(`${featureKey} limit reached. Upgrade your plan.`);
}

// Increments usage, creating the user's quota row on first use. Always recorded,
// including for users with no subscription (see limitFor).
async function consume(userId, featureKey, by = 1) {
  if (by <= 0) return;
  const usage = await quotaRepo.findByUserId(userId);
  if (!usage) await quotaRepo.create({ user_id: userId });
  await quotaRepo.increment(userId, fieldFor(featureKey), by);
}

// Gives usage back — storage freed when a file is deleted. Floored at zero in the
// repository so a double release (or a counter that predates the ledger) can
// never drive the column negative and hand out free storage.
async function release(userId, featureKey, by = 1) {
  if (by <= 0) return;
  await quotaRepo.decrement(userId, fieldFor(featureKey), by);
}

// Remaining headroom in counter units, or null when unlimited/unenforced. Used to
// tell a client how much room is left before they start an upload.
async function remaining(userId, featureKey) {
  const limit = await limitFor(userId, featureKey);
  if (limit === null) return null;
  const usage = await quotaRepo.findByUserId(userId);
  const used  = usage ? Number(usage[fieldFor(featureKey)] ?? 0) : 0;
  return Math.max(limit - used, 0);
}

// Boolean plan features (data_type 'boolean', value 1/0) — "may this account do X
// at all", as opposed to the counters above. No active subscription means no
// entitlement: unlike the usage limits, which are deliberately unenforced for
// free accounts, a paid-only capability has to be OFF by default or it is not
// paid-only at all.
async function hasFeature(userId, featureKey) {
  const sub = await userSubRepo.findActiveByUser(userId);
  if (!sub) return false;
  return (await planFeatureRepo.getFeatureValue(sub.plan_id, featureKey)) === 1;
}

module.exports = { assertWithinQuota, consume, release, remaining, hasFeature, FIELD, LIMIT_SCALE, fieldFor, scaleFor };
