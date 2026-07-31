const userQuotaUsageRepo = require('../repositories/userQuotaUsage.repository');
const planFeatureRepo    = require('../repositories/planFeature.repository');
const userSubRepo        = require('../repositories/userSubscription.repository');
const { QuotaError }     = require('../errors');

const quotaCheck = (featureKey) => async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const sub    = await userSubRepo.findActiveByUser(userId);
    if (!sub) return next();

    const limit = await planFeatureRepo.getFeatureValue(sub.plan_id, featureKey);
    if (limit === null || limit === -1) return next();

    const usage = await userQuotaUsageRepo.findByUserId(userId);
    const used  = usage ? (usage[`${featureKey}_count`] ?? usage[featureKey] ?? 0) : 0;

    if (used >= limit) {
      return next(new QuotaError(`${featureKey} limit reached. Upgrade your plan.`));
    }
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = quotaCheck;
