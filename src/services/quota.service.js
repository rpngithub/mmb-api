const planFeatureRepo = require('../repositories/planFeature.repository');
const userSubRepo     = require('../repositories/userSubscription.repository');
const quotaRepo       = require('../repositories/userQuotaUsage.repository');
const { QuotaError }  = require('../errors');

// Maps a plan-feature key to its counter column on user_quota_usage.
const FIELD = {
  downloads:      'downloads_count',
  shares:         'shares_count',
  template_views: 'template_views_count',
  ai_credits:     'ai_credits_used',
};

const fieldFor = (featureKey) => FIELD[featureKey] || `${featureKey}_count`;

// Throws QuotaError when the user is over their plan limit for `featureKey`.
// Mirrors the quotaCheck middleware: users without an active subscription are
// not enforced here, and -1 / unset means unlimited.
async function assertWithinQuota(userId, featureKey) {
  const sub = await userSubRepo.findActiveByUser(userId);
  if (!sub) return;

  const limit = await planFeatureRepo.getFeatureValue(sub.plan_id, featureKey);
  if (limit === null || limit === -1) return;

  const usage = await quotaRepo.findByUserId(userId);
  const used  = usage ? (usage[fieldFor(featureKey)] ?? 0) : 0;
  if (used >= limit) throw new QuotaError(`${featureKey} limit reached. Upgrade your plan.`);
}

// Increments usage, creating the user's quota row on first use.
async function consume(userId, featureKey, by = 1) {
  const usage = await quotaRepo.findByUserId(userId);
  if (!usage) await quotaRepo.create({ user_id: userId });
  await quotaRepo.increment(userId, fieldFor(featureKey), by);
}

module.exports = { assertWithinQuota, consume };
