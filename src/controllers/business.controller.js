const businessService = require('../services/business.service');

const create = async (req, res) => {
  const biz = await businessService.createBusiness(req.user.userId, req.body);
  res.status(201).json({ success: true, data: biz });
};

const list = async (req, res) => {
  const items = await businessService.getMyBusinesses(req.user.userId);
  res.json({ success: true, data: items });
};

const getOne = async (req, res) => {
  const biz = await businessService.getBusiness(req.params.uid, req.user.userId);
  res.json({ success: true, data: biz });
};

const update = async (req, res) => {
  const biz = await businessService.updateBusiness(req.params.uid, req.user.userId, req.body);
  res.json({ success: true, data: biz });
};

const remove = async (req, res) => {
  await businessService.deleteBusiness(req.params.uid, req.user.userId);
  res.json({ success: true, data: null });
};

// ---- Public discovery ----
const nearby = async (req, res) => {
  const items = await businessService.listNearby(req.query);
  res.json({ success: true, data: items });
};

const publicProfile = async (req, res) => {
  const biz = await businessService.getPublicProfile(req.params.uid);
  res.json({ success: true, data: biz });
};

const publicProducts = async (req, res) => {
  const items = await businessService.getPublicProducts(req.params.uid);
  res.json({ success: true, data: items });
};

// ---- Adopted variants ("Use This Brand Series") ----
const listVariants = async (req, res) => {
  const items = await businessService.listAdoptedVariants(req.user.userId, req.params.uid);
  res.json({ success: true, data: items });
};

const adoptVariant = async (req, res) => {
  // `variant_uid` is the current name; `theme_uid` the deprecated alias.
  const uid     = req.body.variant_uid ?? req.body.theme_uid;
  const variant = await businessService.adoptVariant(req.user.userId, req.params.uid, uid);
  res.status(201).json({ success: true, data: variant });
};

const removeVariant = async (req, res) => {
  const uid = req.params.variantUid ?? req.params.themeUid;
  await businessService.removeAdoptedVariant(req.user.userId, req.params.uid, uid);
  res.json({ success: true, data: null });
};

module.exports = {
  create, list, getOne, update, remove, nearby, publicProfile, publicProducts,
  listVariants, adoptVariant, removeVariant,
};
