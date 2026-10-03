const BaseRepository = require('./base.repository');
const { TemplateFamily } = require('../models');

class TemplateFamilyRepository extends BaseRepository {
  constructor() { super(TemplateFamily); }

  incrementCounter(id, field, transaction) {
    return this.model.increment(field, { by: 1, where: { id }, ...(transaction ? { transaction } : {}) });
  }
}

module.exports = new TemplateFamilyRepository();
