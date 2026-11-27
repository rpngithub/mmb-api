const { Op } = require('sequelize');
const BaseRepository = require('./base.repository');
const { UserFrameDesign, FrameVersion } = require('../models');

// Users' edited copies of frame versions (see userFrameDesign.model).
class UserFrameDesignRepository extends BaseRepository {
  constructor() { super(UserFrameDesign); }

  findForUserAndVersion(userId, versionId) {
    return this.findOne({ user_id: userId, frame_version_id: versionId });
  }

  // The caller's copies among these versions, by version id — one query for a
  // whole version list or a My Frames page. `content` only when asked: it is heavy.
  async mapForUser(userId, versionIds, { withContent = false } = {}) {
    if (!userId || !versionIds.length) return new Map();
    const rows = await this.findMany(
      { user_id: userId, frame_version_id: { [Op.in]: versionIds } },
      withContent ? {} : { attributes: { exclude: ['content'] } },
    );
    return new Map(rows.map((r) => [r.frame_version_id, r]));
  }

  // Every copy a user has of any version of one frame.
  findForUserAndFrame(userId, frameId, transaction) {
    return this.findMany({ user_id: userId }, {
      attributes: { exclude: ['content'] },
      include:    [{ model: FrameVersion, attributes: [], where: { frame_id: frameId }, required: true }],
      transaction,
    });
  }

  // Every user's copy of these versions.
  findForVersions(versionIds, transaction) {
    if (!versionIds.length) return Promise.resolve([]);
    return this.findMany({ frame_version_id: { [Op.in]: versionIds } }, {
      attributes: ['id', 'thumbnail_s3_key'], transaction,
    });
  }
}

module.exports = new UserFrameDesignRepository();
