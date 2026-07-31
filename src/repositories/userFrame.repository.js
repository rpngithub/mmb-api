const BaseRepository = require('./base.repository');
const { UserFrame } = require('../models');

class UserFrameRepository extends BaseRepository {
  constructor() { super(UserFrame); }

  findMyFrames(userId) {
    return this.findMany({ user_id: userId, is_active: 1 }, { order: [['id', 'DESC']] });
  }
}

module.exports = new UserFrameRepository();
