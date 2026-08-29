const BaseRepository = require('./base.repository');
const { QuotaPack, FeatureType } = require('../models');

// The feature a pack sells is part of what the pack IS — a quantity with no unit
// is meaningless — so both the store and the admin list always carry it.
const FEATURE = {
  model: FeatureType,
  attributes: ['id', 'key', 'label', 'reset_period', 'data_type', 'is_topupable'],
};

class QuotaPackRepository extends BaseRepository {
  constructor() { super(QuotaPack); }

  // Store browse. Small shelf, so no pagination — the whole active set for one
  // feature, in the order the admin arranged it.
  findForStore(where, options = {}) {
    return this.findMany(where, {
      include: [FEATURE],
      order:   [['display_order', 'ASC'], ['id', 'ASC']],
      ...options,
    });
  }

  findForAdmin(where, options = {}) {
    // `distinct` so the count is COUNT(DISTINCT QuotaPack.id): the feature include
    // is a belongsTo and cannot multiply rows today, but a paged total that
    // silently depends on that staying true is the kind of thing that breaks on
    // the next join.
    return this.findAndCountAll(where, {
      distinct: true,
      include:  [FEATURE],
      order:    [['display_order', 'ASC'], ['id', 'DESC']],
      ...options,
    });
  }

  findActiveByUid(uid) {
    return this.findOne({ uid, status: 'active' }, { include: [FEATURE] });
  }
}

module.exports = new QuotaPackRepository();
