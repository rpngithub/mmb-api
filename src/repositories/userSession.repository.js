const BaseRepository = require('./base.repository');
const { UserSession } = require('../models');

class UserSessionRepository extends BaseRepository {
  constructor() { super(UserSession); }

  findByJti(jti) { return this.findOne({ jti }); }

  revokeByJti(jti, transaction) {
    return this.model.update({ is_revoked: 1 }, { where: { jti }, ...(transaction ? { transaction } : {}) });
  }

  revokeAllForActor(actorType, actorId, transaction) {
    return this.model.update(
      { is_revoked: 1 },
      { where: { actor_type: actorType, actor_id: actorId }, ...(transaction ? { transaction } : {}) }
    );
  }
}

module.exports = new UserSessionRepository();
