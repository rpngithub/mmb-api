const { v4: uuid }  = require('uuid');
const productRepo   = require('../repositories/product.repository');
const businessRepo  = require('../repositories/business.repository');
const { ProductImage } = require('../models');
const { NotFoundError, ForbiddenError } = require('../errors');

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

async function createProduct(userId, { business_uid, ...data }) {
  const biz = await _assertBusinessOwner(business_uid, userId);
  return productRepo.create({ ...data, uid: uuid(), business_id: biz.id });
}

async function listProducts(userId, businessUid) {
  const biz = await _assertBusinessOwner(businessUid, userId);
  return productRepo.findByBusiness(biz.id);
}

async function getProduct(uid, userId) {
  await _loadOwnedProduct(uid, userId);
  return productRepo.findByUidWithImages(uid);
}

async function updateProduct(uid, userId, data) {
  const product = await _loadOwnedProduct(uid, userId);
  await productRepo.update(product.id, data);
  return productRepo.findByUidWithImages(uid);
}

async function deleteProduct(uid, userId) {
  const product = await _loadOwnedProduct(uid, userId);
  await productRepo.update(product.id, { is_active: 0 });
}

async function addImage(uid, userId, { s3_key, display_order }) {
  const product = await _loadOwnedProduct(uid, userId);
  return ProductImage.create({ product_id: product.id, s3_key, display_order: display_order || 0 });
}

async function removeImage(uid, imageId, userId) {
  const product = await _loadOwnedProduct(uid, userId);
  await ProductImage.destroy({ where: { id: imageId, product_id: product.id } });
}

module.exports = {
  createProduct, listProducts, getProduct, updateProduct, deleteProduct, addImage, removeImage,
};
