const BaseRepository = require('./base.repository');
const { UserQuotaUsage } = require('../models');

class UserQuotaUsageRepository extends BaseRepository {
  constructor() { super(UserQuotaUsage); }

  findByUserId(userId) { return this.findOne({ user_id: userId }); }

  increment(userId, field, by = 1, transaction) {
    return this.model.increment(field, {
      by,
      where: { user_id: userId },
      ...(transaction ? { transaction } : {}),
    });
  }

  resetPeriodCounters(userId, periodStart, periodEnd, transaction) {
    return this.model.update(
      { ai_credits_used: 0, downloads_count: 0, shares_count: 0, template_views_count: 0, period_start: periodStart, period_end: periodEnd },
      { where: { user_id: userId }, ...(transaction ? { transaction } : {}) }
    );
  }
}

module.exports = new UserQuotaUsageRepository();
