const BaseRepository = require('./base.repository');
const { Template } = require('../models');

// Template VERSIONS (one language × size of a design). Counters live on the family:
// see templateFamily.repository.
class TemplateRepository extends BaseRepository {
  constructor() { super(Template); }

  findActive(options = {}) {
    return this.findMany({ status: 'active' }, options);
  }
}

module.exports = new TemplateRepository();
