const BaseRepository = require('./base.repository');
const { BusinessCategory } = require('../models');

class BusinessCategoryRepository extends BaseRepository {
  constructor() { super(BusinessCategory); }

  findRoots() { return this.findMany({ parent_id: null, is_active: 1 }); }
}

module.exports = new BusinessCategoryRepository();
