const { literal } = require('sequelize');
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

  // Give usage back (storage freed by a delete). GREATEST(...,0) rather than a
  // plain decrement: a double release, or a release against a counter that
  // predates the upload ledger, must not push the column negative — that would
  // read as free headroom the user has not actually got.
  decrement(userId, field, by = 1, transaction) {
    const col = this.model.sequelize.getQueryInterface().quoteIdentifier(field);
    return this.model.update(
      { [field]: literal(`GREATEST(${col} - ${Math.trunc(by)}, 0)`) },
      { where: { user_id: userId }, ...(transaction ? { transaction } : {}) },
    );
  }

  resetPeriodCounters(userId, periodStart, periodEnd, transaction) {
    return this.model.update(
      { ai_credits_used: 0, downloads_count: 0, shares_count: 0, template_views_count: 0, period_start: periodStart, period_end: periodEnd },
      { where: { user_id: userId }, ...(transaction ? { transaction } : {}) }
    );
  }
}

module.exports = new UserQuotaUsageRepository();
