const { literal } = require('sequelize');
const BaseRepository = require('./base.repository');
const { Frame, FrameCategory } = require('../models');
const { requiredVersionAttr } = require('../services/framePublish');

const FRAME = '`Frame`.`id`';

// Correlated count against frame_versions — one query for the whole page.
const versionCount = (alias, extra = '') =>
  [literal(`(SELECT COUNT(*) FROM \`frame_versions\` v WHERE v.frame_id = ${FRAME}${extra})`), alias];

// What the admin list needs per row without loading versions' heavy `content`:
// version counts and the signal the publish checklist reads.
const ADMIN_ATTRS = [
  versionCount('version_count'),
  versionCount('active_version_count', " AND v.status = 'active'"),
  requiredVersionAttr(FRAME),
];

const CATEGORY_ATTRS = ['id', 'uid', 'name', 'slug'];

class FrameRepository extends BaseRepository {
  constructor() { super(Frame); }

  // Store browse. The designs live on frame_versions and are picked per viewer by
  // the service, so this returns the frames only.
  findForStore(where, options = {}) {
    // `distinct` so the count is COUNT(DISTINCT Frame.id): the category include is
    // a belongsTo and cannot multiply rows today, but a paged total that silently
    // depends on that staying true is the kind of thing that breaks on the next join.
    return this.findAndCountAll(where, {
      distinct: true,
      include:  [{ model: FrameCategory, attributes: CATEGORY_ATTRS }],
      order:    [['display_order', 'ASC'], ['id', 'DESC']],
      ...options,
    });
  }

  // Admin browse, with the counts and readiness signal above.
  findForAdmin(where, options = {}) {
    return this.findAndCountAll(where, {
      distinct:   true,
      attributes: { include: ADMIN_ATTRS },
      include:    [{ model: FrameCategory, attributes: CATEGORY_ATTRS }],
      order:      [['display_order', 'ASC'], ['id', 'DESC']],
      ...options,
    });
  }

  findActiveByUid(uid) {
    return this.findOne({ uid, status: 'active' }, {
      include: [{ model: FrameCategory, attributes: CATEGORY_ATTRS }],
    });
  }
}

module.exports = new FrameRepository();
