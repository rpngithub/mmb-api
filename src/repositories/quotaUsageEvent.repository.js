const { fn, col, literal, Op } = require('sequelize');
const BaseRepository = require('./base.repository');
const { QuotaUsageEvent } = require('../models');

class QuotaUsageEventRepository extends BaseRepository {
  constructor() { super(QuotaUsageEvent); }

  // "Breakdown by tool" — spend per source for one feature over one window.
  //
  // Only POSITIVE amounts count: a release is a refund, and netting it off would
  // make the breakdown disagree with the "used this cycle" figure above it, which
  // the counter reports gross. `since` is the period start; NULL means the account
  // has no cycle (no subscription), so report everything on record.
  //
  // `net` is for FLOW features (ai_credits), where a negative row is a refund of
  // a failed AI job and the counter was lowered with it: there the breakdown has
  // to net refunds off too, or a refunded image would still show as spent.
  async breakdown(userId, featureTypeId, since, { net = false } = {}) {
    const rows = await this.model.findAll({
      where: {
        user_id: userId,
        feature_type_id: featureTypeId,
        ...(net ? {} : { amount: { [Op.gt]: 0 } }),
        ...(since ? { created_at: { [Op.gte]: since } } : {}),
      },
      attributes: [
        'source',
        [fn('SUM', col('amount')), 'used'],
      ],
      group: ['source'],
      order: [[literal('used'), 'DESC']],
      raw: true,
    });

    return rows.map((r) => ({ source: r.source, used: Number(r.used || 0) }));
  }

  // Retention sweep — see jobs/quotaEventCleanup.job.js.
  deleteOlderThan(cutoff) {
    return this.model.destroy({ where: { created_at: { [Op.lt]: cutoff } } });
  }
}

module.exports = new QuotaUsageEventRepository();
