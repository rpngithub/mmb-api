const { fn, col, literal, Op } = require('sequelize');
const BaseRepository = require('./base.repository');
const { UserQuotaGrant, QuotaPack, FeatureType } = require('../models');

class UserQuotaGrantRepository extends BaseRepository {
  constructor() { super(UserQuotaGrant); }

  // The whole balance in one query: granted and consumed for one user and one
  // feature, over active grants only. Pending grants (ordered, unconfirmed) and
  // revoked ones contribute nothing — a revoked grant drops BOTH its quantity and
  // its consumed, which is what makes revoking a fully-spent grant a no-op rather
  // than a clawback that could drive the balance negative.
  //
  // Returned in the FEATURE's own unit (credits / MB); quota.service scales.
  async balanceFor(userId, featureTypeId, transaction) {
    const row = await this.model.findOne({
      where: { user_id: userId, feature_type_id: featureTypeId, status: 'active' },
      attributes: [
        [fn('COALESCE', fn('SUM', col('quantity')), 0), 'granted'],
        [fn('COALESCE', fn('SUM', col('consumed')), 0), 'consumed'],
      ],
      raw: true,
      ...(transaction ? { transaction } : {}),
    });

    return { granted: Number(row?.granted || 0), consumed: Number(row?.consumed || 0) };
  }

  // Every feature's balance for one user in a single query, keyed by
  // feature_type_id. The usage summary reports six features at once and would
  // otherwise fire six of the query above — on an endpoint the app polls after
  // checkout.
  async balancesFor(userId) {
    const rows = await this.model.findAll({
      where: { user_id: userId, status: 'active' },
      attributes: [
        'feature_type_id',
        [fn('COALESCE', fn('SUM', col('quantity')), 0), 'granted'],
        [fn('COALESCE', fn('SUM', col('consumed')), 0), 'consumed'],
      ],
      group: ['feature_type_id'],
      raw: true,
    });

    return new Map(rows.map((r) => [
      Number(r.feature_type_id),
      { granted: Number(r.granted || 0), consumed: Number(r.consumed || 0) },
    ]));
  }

  // Active grants with headroom left, oldest first — the FIFO order spending is
  // debited in. Locked when a transaction is supplied so two concurrent spends
  // cannot both read the same remaining balance and each debit it.
  findSpendable(userId, featureTypeId, transaction) {
    return this.model.findAll({
      where: {
        user_id: userId, feature_type_id: featureTypeId, status: 'active',
        [Op.and]: literal('consumed < quantity'),
      },
      order: [['id', 'ASC']],
      ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  findByPaymentId(paymentId) {
    return this.findOne({ payment_id: paymentId });
  }

  // A user's grant history for the admin detail view, newest first.
  findForUser(userId, where = {}) {
    return this.findMany({ user_id: userId, ...where }, {
      include: [
        { model: FeatureType, attributes: ['id', 'key', 'label'] },
        { model: QuotaPack,   attributes: ['id', 'uid', 'name'] },
      ],
      order: [['id', 'DESC']],
    });
  }

  // Debit `by` units against one grant. Guarded so the UPDATE itself enforces the
  // ceiling: `assertWithinQuota`'s check is a read that can race, this cannot
  // overdraw. Returns the number of rows changed, so the caller can tell whether
  // it actually landed.
  async debit(grantId, by, transaction) {
    const [changed] = await this.model.update(
      { consumed: literal(`consumed + ${Math.trunc(by)}`) },
      {
        where: {
          id: grantId,
          [Op.and]: literal(`consumed + ${Math.trunc(by)} <= quantity`),
        },
        ...(transaction ? { transaction } : {}),
      },
    );
    return changed;
  }
}

module.exports = new UserQuotaGrantRepository();
