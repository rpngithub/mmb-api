class BaseRepository {
  constructor(model) {
    this.model = model;
  }

  findById(id, options = {}) {
    return this.model.findOne({ where: { id }, ...options });
  }

  findByUid(uid, options = {}) {
    return this.model.findOne({ where: { uid }, ...options });
  }

  findOne(where, options = {}) {
    return this.model.findOne({ where, ...options });
  }

  findMany(where = {}, options = {}) {
    return this.model.findAll({ where, ...options });
  }

  findAndCountAll(where = {}, options = {}) {
    return this.model.findAndCountAll({ where, ...options });
  }

  create(data, transaction) {
    return this.model.create(data, transaction ? { transaction } : {});
  }

  update(id, data, transaction) {
    return this.model.update(data, {
      where: { id },
      ...(transaction ? { transaction } : {}),
    });
  }

  delete(id, transaction) {
    return this.model.destroy({
      where: { id },
      ...(transaction ? { transaction } : {}),
    });
  }

  bulkCreate(rows, transaction) {
    return this.model.bulkCreate(rows, transaction ? { transaction } : {});
  }
}

module.exports = BaseRepository;
