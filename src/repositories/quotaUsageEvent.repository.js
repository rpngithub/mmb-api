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

  // Has anything ever been charged to this feature for this ref? Lets a project
  // that flips image → video → image → video count once per bucket instead of on
  // every flip. Bounded by the retention sweep below, so a ref charged before the
  // retention window can be charged again — acceptable for an edge that rare.
  async hasSpend(userId, featureTypeId, refType, refId) {
    const row = await this.model.findOne({
      where: { user_id: userId, feature_type_id: featureTypeId, ref_type: refType, ref_id: refId, amount: { [Op.gt]: 0 } },
      attributes: ['id'],
    });
    return Boolean(row);
  }

  // Retention sweep — see jobs/quotaEventCleanup.job.js.
  deleteOlderThan(cutoff) {
    return this.model.destroy({ where: { created_at: { [Op.lt]: cutoff } } });
  }
}

module.exports = new QuotaUsageEventRepository();
