const BaseRepository = require('./base.repository');
const { UserQuotaUsage } = require('../models');

// The account's usage window only. Counters live in userQuotaCounter.repository.
class UserQuotaUsageRepository extends BaseRepository {
  constructor() { super(UserQuotaUsage); }

  findByUserId(userId) { return this.findOne({ user_id: userId }); }

  // Stamp the window. Used both when a cycle rolls (quota.service zeroes the
  // recurring counters alongside) and the first time a period is established for
  // an account whose counters predate period tracking: those totals were
  // accumulated with no window at all, and adopting them as this period's usage
  // is the conservative reading — treating them as a completed period instead
  // would hand every existing account a free allowance.
  setPeriod(userId, periodStart, periodEnd, transaction) {
    return this.model.update(
      { period_start: periodStart, period_end: periodEnd },
      { where: { user_id: userId }, ...(transaction ? { transaction } : {}) }
    );
  }
}

module.exports = new UserQuotaUsageRepository();
