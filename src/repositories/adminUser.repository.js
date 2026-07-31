const BaseRepository = require('./base.repository');
const { AdminUser, Role } = require('../models');

class AdminUserRepository extends BaseRepository {
  constructor() { super(AdminUser); }

  findByEmail(email) {
    return this.model.findOne({ where: { email }, include: [{ model: Role }] });
  }

  // Override so admin lookups by id carry the Role (and its permissions). The
  // token refresh flow relies on this to re-embed the `permissions` claim.
  findById(id, options = {}) {
    return this.model.findOne({ where: { id }, include: [{ model: Role }], ...options });
  }
}

module.exports = new AdminUserRepository();
