const { Op } = require('sequelize');
const BaseRepository = require('./base.repository');
const { UserFrame, Frame, FrameCategory } = require('../models');

// Rows a user can actually use. 'pending' is an unconfirmed purchase and
// 'removed' is a frame they took off the shelf — neither counts as owned.
const OWNED = { status: 'active' };

class UserFrameRepository extends BaseRepository {
  constructor() { super(UserFrame); }

  // The single (user, frame) row, whatever its status — the unique index
  // guarantees at most one, which is what lets add/purchase reuse it instead of
  // charging a second time for a frame that was bought and then removed.
  findForUserAndFrame(userId, frameId) {
    return this.findOne({ user_id: userId, frame_id: frameId });
  }

  // "My Frames", newest first.
  findMine(userId) {
    return this.findMany({ user_id: userId, ...OWNED }, {
      include: [{
        model: Frame,
        include: [{ model: FrameCategory, attributes: ['id', 'uid', 'name', 'slug'] }],
      }],
      order: [['id', 'DESC']],
    });
  }

  // Which of these frame ids does the viewer already own? One query for a whole
  // store page, so the grid can mark every card without a per-card round trip.
  async ownedFrameIds(userId, frameIds) {
    if (!userId || !frameIds.length) return new Set();
    const rows = await this.findMany(
      { user_id: userId, frame_id: { [Op.in]: frameIds }, ...OWNED },
      { attributes: ['frame_id'] },
    );
    return new Set(rows.map((r) => r.frame_id));
  }

  findByPaymentId(paymentId) {
    return this.findOne({ payment_id: paymentId });
  }
}

module.exports = new UserFrameRepository();
