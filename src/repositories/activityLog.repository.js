const BaseRepository = require('./base.repository');
const { ActivityLog } = require('../models');
const { Op } = require('sequelize');

class ActivityLogRepository extends BaseRepository {
  constructor() { super(ActivityLog); }

  findRecentByTemplate(templateId, since) {
    return this.findMany(
      { entity_type: 'template', entity_id: templateId, created_at: { [Op.gte]: since } }
    );
  }
}

module.exports = new ActivityLogRepository();
