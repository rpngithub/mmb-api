const BaseRepository = require('./base.repository');
const { Project } = require('../models');

class ProjectRepository extends BaseRepository {
  constructor() { super(Project); }

  findMyProjects(userId, options = {}) {
    return this.findMany({ user_id: userId, parent_project_id: null }, options);
  }
}

module.exports = new ProjectRepository();
