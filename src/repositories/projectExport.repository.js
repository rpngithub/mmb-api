const BaseRepository = require('./base.repository');
const { ProjectExport } = require('../models');

class ProjectExportRepository extends BaseRepository {
  constructor() { super(ProjectExport); }

  findByProject(projectId) {
    return this.findMany({ project_id: projectId }, { order: [['id', 'DESC']] });
  }
}

module.exports = new ProjectExportRepository();
