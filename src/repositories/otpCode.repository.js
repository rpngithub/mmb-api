const BaseRepository = require('./base.repository');
const { OtpCode } = require('../models');
const { Op } = require('sequelize');

class OtpCodeRepository extends BaseRepository {
  constructor() { super(OtpCode); }

  findActive(phone, purpose) {
    return this.findOne({
      phone,
      purpose,
      is_used: 0,
      expires_at: { [Op.gt]: new Date() },
    });
  }

  purgeExpired() {
    return this.model.destroy({ where: { expires_at: { [Op.lt]: new Date() } } });
  }
}

module.exports = new OtpCodeRepository();
