const BaseRepository = require('./base.repository');
const { User } = require('../models');

class UserRepository extends BaseRepository {
  constructor() { super(User); }

  findByEmail(email) { return this.findOne({ email }); }
  findByPhone(phone) { return this.findOne({ phone }); }
}

module.exports = new UserRepository();
