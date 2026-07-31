const BaseRepository = require('./base.repository');
const { Role } = require('../models');

class RoleRepository extends BaseRepository {
  constructor() { super(Role); }
}

module.exports = new RoleRepository();
