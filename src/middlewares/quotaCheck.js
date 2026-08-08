const quota = require('../services/quota.service');

// Route-level guard: rejects the request when the caller is already at their plan
// limit for `featureKey`. Currently mounted on nothing — services call
// quota.service directly (see projectExport.service) — but kept because it is the
// natural way to gate a route.
//
// It delegates rather than reimplementing the lookup. It previously carried its
// own copy, with the same field-mapping bug quota.service had (`storage` -> the
// non-existent `storage_count` column, so the limit could never be reached), and
// two copies of one rule is how they drift apart in the first place.
const quotaCheck = (featureKey) => async (req, res, next) => {
  try {
    await quota.assertWithinQuota(req.user.userId, featureKey);
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = quotaCheck;
