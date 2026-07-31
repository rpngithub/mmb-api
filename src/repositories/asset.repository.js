const BaseRepository = require('./base.repository');
const { Asset } = require('../models');

class AssetRepository extends BaseRepository {
  constructor() { super(Asset); }
}

module.exports = new AssetRepository();
