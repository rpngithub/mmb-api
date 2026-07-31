const BaseRepository = require('./base.repository');
const { TokenBlacklist } = require('../models');

class TokenBlacklistRepository extends BaseRepository {
  constructor() { super(TokenBlacklist); }

  isBlacklisted(jti) {
    return this.model.findOne({ where: { jti } }).then(Boolean);
  }

  addToBlacklist(data, transaction) {
    return this.create(data, transaction);
  }

  purgeExpired() {
    const { Op } = require('sequelize');
    return this.model.destroy({ where: { expires_at: { [Op.lt]: new Date() } } });
  }
}

module.exports = new TokenBlacklistRepository();
