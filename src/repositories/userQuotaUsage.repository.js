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

  // Start a new billing period: zero the counters that recur and stamp the window.
  //
  // Only the FLOW counters are zeroed. `template_views_count` used to be in this
  // list, but its feature_type declares reset_period 'never' — it is a lifetime
  // total, like storage, and zeroing it would have quietly discarded the figure
  // every month. (`storage_used_bytes` was correctly never here: it is occupancy,
  // and zeroing it would hand out free space.)
  resetPeriodCounters(userId, periodStart, periodEnd, transaction) {
    return this.model.update(
      {
        ai_credits_used: 0, downloads_count: 0, shares_count: 0,
        period_start: periodStart, period_end: periodEnd,
      },
      { where: { user_id: userId }, ...(transaction ? { transaction } : {}) }
    );
  }

  // Stamp the window WITHOUT touching the counters. Used the first time a period
  // is established for an account whose counters predate period tracking: those
  // totals were accumulated with no window at all, and adopting them as this
  // period's usage is the conservative reading — treating them as a completed
  // period instead would hand every existing account a free allowance.
  setPeriod(userId, periodStart, periodEnd, transaction) {
    return this.model.update(
      { period_start: periodStart, period_end: periodEnd },
      { where: { user_id: userId }, ...(transaction ? { transaction } : {}) }
    );
  }
}

module.exports = new UserQuotaUsageRepository();
