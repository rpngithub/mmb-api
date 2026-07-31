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

// ---- Adopted themes ("Add to your Business") ----
const listThemes = async (req, res) => {
  const items = await businessService.listAdoptedThemes(req.user.userId, req.params.uid);
  res.json({ success: true, data: items });
};

const adoptTheme = async (req, res) => {
  const theme = await businessService.adoptTheme(req.user.userId, req.params.uid, req.body.theme_uid);
  res.status(201).json({ success: true, data: theme });
};

const removeTheme = async (req, res) => {
  await businessService.removeAdoptedTheme(req.user.userId, req.params.uid, req.params.themeUid);
  res.json({ success: true, data: null });
};

module.exports = {
  create, list, getOne, update, remove, nearby, publicProfile, publicProducts,
  listThemes, adoptTheme, removeTheme,
};
