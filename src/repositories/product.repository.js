const BaseRepository = require('./base.repository');
const { Product, ProductImage } = require('../models');

// Deleted rows never surface: the model is paranoid, so every read here already
// carries `deleted_at IS NULL`.
class ProductRepository extends BaseRepository {
  constructor() { super(Product); }

  // Owner's list: everything the business still has, active or not, so the
  // Manage Products tabs (All / Products / Services / In Active) can be driven
  // from one call. `type` and `is_active` narrow it.
  findByBusiness(businessId, { type, is_active } = {}) {
    const where = { business_id: businessId };
    if (type !== undefined)      where.type      = type;
    if (is_active !== undefined) where.is_active = is_active;
    // Images in display_order so ProductImages[0] is the card image.
    return this.findMany(where, {
      include: [{ model: ProductImage }],
      order:   [['id', 'DESC'], [ProductImage, 'display_order', 'ASC'], [ProductImage, 'id', 'ASC']],
    });
  }

  // Storefront / Near Me: only what the owner has switched on.
  findActiveByBusiness(businessId, { type } = {}) {
    return this.findByBusiness(businessId, { type, is_active: 1 });
  }

  findByUidWithImages(uid) {
    return this.findByUid(uid, {
      include: [{ model: ProductImage }],
      order:   [[ProductImage, 'display_order', 'ASC'], [ProductImage, 'id', 'ASC']],
    });
  }
}

module.exports = new ProductRepository();
