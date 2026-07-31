const BaseRepository = require('./base.repository');
const { AppSetting } = require('../models');

class AppSettingRepository extends BaseRepository {
  constructor() { super(AppSetting); }

  findByKey(key)    { return this.findOne({ key }); }
  findPublic()      { return this.findMany({ is_public: 1 }); }
  findByGroup(group){ return this.findMany({ group }); }
}

module.exports = new AppSettingRepository();
