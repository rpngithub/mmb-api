const BaseRepository = require('./base.repository');
const { Product, ProductImage } = require('../models');

class ProductRepository extends BaseRepository {
  constructor() { super(Product); }

  findByBusiness(businessId) {
    return this.findMany(
      { business_id: businessId, is_active: 1 },
      { include: [{ model: ProductImage }], order: [['id', 'DESC']] }
    );
  }

  findByUidWithImages(uid) {
    return this.findByUid(uid, { include: [{ model: ProductImage }] });
  }
}

module.exports = new ProductRepository();
