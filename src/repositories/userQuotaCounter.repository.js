const { Op, literal } = require('sequelize');
const BaseRepository = require('./base.repository');
const { UserQuotaCounter } = require('../models');

const tx = (transaction) => (transaction ? { transaction } : {});

class UserQuotaCounterRepository extends BaseRepository {
  constructor() { super(UserQuotaCounter); }

  async used(userId, featureTypeId, transaction) {
    const row = await this.model.findOne({
      where: { user_id: userId, feature_type_id: featureTypeId },
      attributes: ['used'], ...tx(transaction),
    });
    return row ? Number(row.used) : 0;
  }

  // Map<feature_type_id, used> for one user — the Usage screen reads every
  // feature at once.
  async usedMap(userId) {
    const rows = await this.model.findAll({
      where: { user_id: userId }, attributes: ['feature_type_id', 'used'], raw: true,
    });
    return new Map(rows.map((r) => [Number(r.feature_type_id), Number(r.used)]));
  }

  // Upsert-and-add in one statement, so two first-ever spends racing each other
  // cannot both insert.
  increment(userId, featureTypeId, by, transaction) {
    return this.model.sequelize.query(
      `INSERT INTO user_quota_counters (user_id, feature_type_id, used, created_at, updated_at)
       VALUES (:userId, :featureTypeId, :by, NOW(), NOW())
       ON DUPLICATE KEY UPDATE used = used + VALUES(used), updated_at = NOW()`,
      { replacements: { userId, featureTypeId, by: Math.trunc(by) }, ...tx(transaction) },
    );
  }

  // Give usage back (storage freed by a delete). GREATEST(...,0) rather than a
  // plain decrement: a double release, or a release against a counter that
  // predates the upload ledger, must not push it negative — that would read as
  // free headroom the user has not actually got.
  decrement(userId, featureTypeId, by, transaction) {
    return this.model.update(
      { used: literal(`GREATEST(CAST(used AS SIGNED) - ${Math.trunc(by)}, 0)`) },
      { where: { user_id: userId, feature_type_id: featureTypeId }, ...tx(transaction) },
    );
  }

  // Zero the tallies that recur this cycle. Gauges are never passed in: zeroing
  // occupancy would hand out free space.
  reset(userId, featureTypeIds, transaction) {
    if (!featureTypeIds.length) return Promise.resolve();
    return this.model.update(
      { used: 0 },
      { where: { user_id: userId, feature_type_id: { [Op.in]: featureTypeIds } }, ...tx(transaction) },
    );
  }
}

module.exports = new UserQuotaCounterRepository();
