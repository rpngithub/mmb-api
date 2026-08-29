const { Op } = require('sequelize');
const BaseRepository = require('./base.repository');
const { FeatureType } = require('../models');

// Deliberately uncached. feature_types is six rows and every lookup here is a
// unique-index hit, so it is noise next to the subscription and usage reads that
// surround it — whereas a cache would go stale the moment an admin edits a
// feature through /admin/feature-types, and a quota decision made against a stale
// reset_period is a bug that would be very hard to see.
class FeatureTypeRepository extends BaseRepository {
  constructor() { super(FeatureType); }

  findByKey(key) {
    return this.findOne({ key });
  }

  findByKeys(keys) {
    return this.findMany({ key: { [Op.in]: keys } });
  }

  findTopupable() {
    return this.findMany({ is_topupable: 1 });
  }
}

module.exports = new FeatureTypeRepository();
