const { v4: uuid }  = require('uuid');
const productRepo   = require('../repositories/product.repository');
const businessRepo  = require('../repositories/business.repository');
const userUpload    = require('./userUpload.service');
const { Product, ProductImage } = require('../models');
const { NotFoundError, ForbiddenError, ValidationError } = require('../errors');

// Products are owned transitively through their business.
async function _assertBusinessOwner(businessUid, userId) {
  const biz = await businessRepo.findByUid(businessUid);
  if (!biz) throw new NotFoundError('Business not found');
  if (biz.user_id !== userId) throw new ForbiddenError('Access denied');
  return biz;
}

async function _loadOwnedProduct(uid, userId) {
  const product = await productRepo.findByUid(uid);
  if (!product) throw new NotFoundError('Product not found');
  const biz = await businessRepo.findById(product.business_id);
  if (!biz || biz.user_id !== userId) throw new ForbiddenError('Access denied');
  return product;
}

const blank = (v) => v === undefined || v === null || v === '';

// The cross-field rules, checked against the row AS IT WILL BE after the write
// (`merged`), so a PATCH that sends only `offer_price` is still held to the
// stored `price`, and one that flips `type` must not leave the other type's
// detail behind. Joi cannot see the stored row, so this lives here.
//
//   - a product carries `unit`, a service carries `service_area`, never both
//   - an offer price needs an actual price, and cannot exceed it
//
// Returns the writable data with '' folded to null (a cleared field) and the
// field that no longer applies after a type change nulled out.
function _normalise(merged, data) {
  const out = { ...data };
  for (const k of ['unit', 'service_area', 'price', 'offer_price', 'description']) {
    if (k in out && out[k] === '') out[k] = null;
  }

  const details = [];
  if (merged.type === 'service' && !blank(merged.unit)) {
    if ('unit' in data) details.push({ field: 'unit', message: 'unit applies to products only' });
    else out.unit = null;                       // type changed under an existing unit: drop it
  }
  if (merged.type === 'product' && !blank(merged.service_area)) {
    if ('service_area' in data) details.push({ field: 'service_area', message: 'service_area applies to services only' });
    else out.service_area = null;
  }
  if (!blank(merged.offer_price)) {
    const actual = Number(merged.price);
    const offer  = Number(merged.offer_price);
    if (blank(merged.price)) {
      details.push({ field: 'offer_price', message: 'offer_price requires a price' });
    } else if (offer > actual) {
      details.push({ field: 'offer_price', message: 'offer_price cannot exceed price' });
    }
  }
  if (details.length) throw new ValidationError('Validation failed', details);
  return out;
}

async function createProduct(userId, { business_uid, ...data }) {
  const biz = await _assertBusinessOwner(business_uid, userId);
  const merged = { type: 'product', ...data };
  const row = _normalise(merged, merged);
  return productRepo.create({ ...row, uid: uuid(), business_id: biz.id });
}

// Owner list, with the tab counts alongside so the screen needs one call.
// Filters come off the query string, so they arrive as strings.
async function listProducts(userId, { business_uid, type, is_active } = {}) {
  if (!business_uid) throw new ValidationError('business_uid is required');
  if (type !== undefined && !Product.TYPES.includes(type)) {
    throw new ValidationError(`type must be one of: ${Product.TYPES.join(', ')}`);
  }
  if (is_active !== undefined && !['0', '1'].includes(String(is_active))) {
    throw new ValidationError('is_active must be 0 or 1');
  }
  const biz  = await _assertBusinessOwner(business_uid, userId);
  const all  = await productRepo.findByBusiness(biz.id);
  const counts = {
    all:      all.length,
    products: all.filter((p) => p.type === 'product').length,
    services: all.filter((p) => p.type === 'service').length,
    inactive: all.filter((p) => !p.is_active).length,
  };
  const items = all.filter((p) =>
    (type === undefined || p.type === type)
    && (is_active === undefined || p.is_active === Number(is_active)));
  return { items, counts };
}

async function getProduct(uid, userId) {
  await _loadOwnedProduct(uid, userId);
  return productRepo.findByUidWithImages(uid);
}

async function updateProduct(uid, userId, data) {
  const product = await _loadOwnedProduct(uid, userId);
  const merged  = { ...product.get({ plain: true }), ...data };
  await productRepo.update(product.id, _normalise(merged, data));
  return productRepo.findByUidWithImages(uid);
}

// A delete is a delete (deleted_at) — distinct from the owner's show/hide
// toggle, which is PATCH { is_active }. The row stays for the tombstone; its
// files do not.
async function deleteProduct(uid, userId) {
  const product = await _loadOwnedProduct(uid, userId);
  await product.destroy();
  await releaseImagesOf(product.id, userId);
}

// Free the storage held by a product's images. The ProductImage rows are left in
// place (the product is only soft-deleted) but the files are gone — there is no
// undelete anywhere in this API, so continuing to charge for content the user
// can never see again would be wrong.
async function releaseImagesOf(productId, userId) {
  const images = await ProductImage.findAll({ where: { product_id: productId }, attributes: ['s3_key'] });
  for (const img of images) await userUpload.release(img.s3_key, userId);
}

async function addImage(uid, userId, { s3_key, display_order }) {
  const product = await _loadOwnedProduct(uid, userId);
  // The key must be one this caller was issued for the product_image slot —
  // without the check, any string is accepted and a product image could be
  // pointed at another user's upload or a premium admin asset.
  await userUpload.assertOwnedKey(s3_key, 'product_image', userId);
  return ProductImage.create({ product_id: product.id, s3_key, display_order: display_order || 0 });
}

async function removeImage(uid, imageId, userId) {
  const product = await _loadOwnedProduct(uid, userId);
  const image   = await ProductImage.findOne({ where: { id: imageId, product_id: product.id } });
  if (!image) return;
  await image.destroy();
  await userUpload.release(image.s3_key, userId);
}

module.exports = {
  createProduct, listProducts, getProduct, updateProduct, deleteProduct, addImage, removeImage,
  releaseImagesOf,
};
