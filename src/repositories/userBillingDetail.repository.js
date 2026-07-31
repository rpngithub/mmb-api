const BaseRepository = require('./base.repository');
const { UserBillingDetail } = require('../models');

class UserBillingDetailRepository extends BaseRepository {
  constructor() { super(UserBillingDetail); }

  findByUserId(userId) { return this.findOne({ user_id: userId }); }
}

module.exports = new UserBillingDetailRepository();
