const { Op } = require('sequelize');
const BaseRepository = require('./base.repository');
const { UserSession } = require('../models');

class UserSessionRepository extends BaseRepository {
  constructor() { super(UserSession); }

  findByJti(jti) { return this.findOne({ jti }); }

  // Refresh has to find the session whether the presented token is the one it
  // currently holds or the one that was just rotated away — the latter is how a
  // replayed (potentially stolen) token gets recognised rather than 404ing.
  findByJtiOrPrev(jti) {
    return this.findOne({ [Op.or]: [{ jti }, { prev_jti: jti }] });
  }

  // Rotates the session's tokens only if it still holds the one the caller
  // verified against, and reports whether it did. Two refreshes racing with the
  // same token would otherwise both write, and the loser's freshly minted token
  // would belong to no session at all — dead on its next use with no explanation.
  // Returning 0 lets the caller tell that client to retry instead.
  async rotateIfCurrent(id, jti, data, transaction) {
    const [count] = await this.model.update(data, {
      where: { id, jti },
      ...(transaction ? { transaction } : {}),
    });
    return count;
  }

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
