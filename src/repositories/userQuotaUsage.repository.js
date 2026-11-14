const BaseRepository = require('./base.repository');
const { UserQuotaUsage } = require('../models');
const { sqlUtc } = require('../utils/sqlDate');

// The account's usage window only. Counters live in userQuotaCounter.repository.
class UserQuotaUsageRepository extends BaseRepository {
  constructor() { super(UserQuotaUsage); }

  findByUserId(userId) { return this.findOne({ user_id: userId }); }

  // The window row, created if missing, in one statement. A find-then-create
  // races when two first-ever spends arrive together (two parallel AI requests
  // from a new account): both find nothing and the second create hits the unique
  // key. INSERT IGNORE makes the loser a no-op instead of an error.
  ensureRow(userId, transaction) {
    return this.model.sequelize.query(
      'INSERT IGNORE INTO user_quota_usage (user_id, updated_at) VALUES (:userId, :now)',
      { replacements: { userId, now: sqlUtc(new Date()) }, ...(transaction ? { transaction } : {}) },
    );
  }

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
