const BaseRepository = require('./base.repository');
const { Project } = require('../models');

class ProjectRepository extends BaseRepository {
  constructor() { super(Project); }

  findMyProjects(userId, { type } = {}, options = {}) {
    return this.findMany({ user_id: userId, parent_project_id: null, ...(type ? { project_type: type } : {}) }, options);
  }
}

module.exports = new ProjectRepository();
