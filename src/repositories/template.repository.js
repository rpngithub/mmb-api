const BaseRepository = require('./base.repository');
const { Template } = require('../models');

class TemplateRepository extends BaseRepository {
  constructor() { super(Template); }

  findActive(options = {}) {
    return this.findMany({ status: 'active' }, options);
  }

  incrementCounter(id, field, transaction) {
    return this.model.increment(field, { by: 1, where: { id }, ...(transaction ? { transaction } : {}) });
  }
}

module.exports = new TemplateRepository();
