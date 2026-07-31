const BaseRepository = require('./base.repository');
const { PlanFeature, FeatureType } = require('../models');

class PlanFeatureRepository extends BaseRepository {
  constructor() { super(PlanFeature); }

  getFeatureValue(planId, featureKey) {
    return this.model.findOne({
      where: { plan_id: planId },
      include: [{ model: FeatureType, where: { key: featureKey } }],
    }).then((row) => (row ? row.value : null));
  }
}

module.exports = new PlanFeatureRepository();
