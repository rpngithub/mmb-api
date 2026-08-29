const { literal } = require('sequelize');
const BaseRepository = require('./base.repository');
const { Frame, FrameCategory } = require('../models');

// Completeness signals for the admin list, mirroring the publish gate without
// shipping the heavy `content` blob: SQL answers "is it non-empty?", which is all
// the checklist needs. Booleans come back as MySQL 1/0.
const COMPLETENESS_ATTRS = [
  [literal("(`Frame`.`content` IS NOT NULL AND `Frame`.`content` <> '')"), 'has_content'],
  [literal("(`Frame`.`thumbnail_s3_key` IS NOT NULL AND `Frame`.`thumbnail_s3_key` <> '')"), 'has_thumbnail'],
];

class FrameRepository extends BaseRepository {
  constructor() { super(Frame); }

  // Store browse. `content` is deliberately excluded: it is the heavy design
  // payload and no grid needs it — the detail endpoint serves it, and only to
  // someone who owns the frame.
  findForStore(where, options = {}) {
    // `distinct` so the count is COUNT(DISTINCT Frame.id): the category include is
    // a belongsTo and cannot multiply rows today, but a paged total that silently
    // depends on that staying true is the kind of thing that breaks on the next join.
    return this.findAndCountAll(where, {
      distinct: true,
      attributes: { exclude: ['content'] },
      include:    [{ model: FrameCategory, attributes: ['id', 'uid', 'name', 'slug'] }],
      order:      [['display_order', 'ASC'], ['id', 'DESC']],
      ...options,
    });
  }

  // Admin browse. Same exclusion of `content` as the store — the detail route
  // serves it — plus the completeness signals the publish checklist reads.
  findForAdmin(where, options = {}) {
    // `distinct` so the count is COUNT(DISTINCT Frame.id): the category include is
    // a belongsTo and cannot multiply rows today, but a paged total that silently
    // depends on that staying true is the kind of thing that breaks on the next join.
    return this.findAndCountAll(where, {
      distinct: true,
      attributes: { exclude: ['content'], include: COMPLETENESS_ATTRS },
      include:    [{ model: FrameCategory, attributes: ['id', 'uid', 'name', 'slug'] }],
      order:      [['display_order', 'ASC'], ['id', 'DESC']],
      ...options,
    });
  }

  findActiveByUid(uid) {
    return this.findOne({ uid, status: 'active' });
  }
}

module.exports = new FrameRepository();
