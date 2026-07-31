const productService = require('../services/product.service');

const create = async (req, res) => {
  const product = await productService.createProduct(req.user.userId, req.body);
  res.status(201).json({ success: true, data: product });
};

const list = async (req, res) => {
  const items = await productService.listProducts(req.user.userId, req.query.business_uid);
  res.json({ success: true, data: items });
};

const getOne = async (req, res) => {
  const product = await productService.getProduct(req.params.uid, req.user.userId);
  res.json({ success: true, data: product });
};

const update = async (req, res) => {
  const product = await productService.updateProduct(req.params.uid, req.user.userId, req.body);
  res.json({ success: true, data: product });
};

const remove = async (req, res) => {
  await productService.deleteProduct(req.params.uid, req.user.userId);
  res.json({ success: true, data: null });
};

const addImage = async (req, res) => {
  const image = await productService.addImage(req.params.uid, req.user.userId, req.body);
  res.status(201).json({ success: true, data: image });
};

const removeImage = async (req, res) => {
  await productService.removeImage(req.params.uid, req.params.imageId, req.user.userId);
  res.json({ success: true, data: null });
};

module.exports = { create, list, getOne, update, remove, addImage, removeImage };
