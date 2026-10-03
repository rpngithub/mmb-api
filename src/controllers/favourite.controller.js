const favouriteService = require('../services/favourite.service');

const listTemplates = async (req, res) => {
  const { total, items } = await favouriteService.listTemplates(req.query, req.user);
  res.json({ success: true, data: items, meta: { total } });
};

const addTemplate = async (req, res) => {
  res.json({ success: true, data: await favouriteService.addTemplate(req.params.uid, req.user) });
};

const removeTemplate = async (req, res) => {
  res.json({ success: true, data: await favouriteService.removeTemplate(req.params.uid, req.user) });
};

const listAssets = async (req, res) => {
  const { total, items } = await favouriteService.listAssets(req.query, req.user);
  res.json({ success: true, data: items, meta: { total } });
};

const addAsset = async (req, res) => {
  res.json({ success: true, data: await favouriteService.addAsset(req.params.uid, req.user) });
};

const removeAsset = async (req, res) => {
  res.json({ success: true, data: await favouriteService.removeAsset(req.params.uid, req.user) });
};

module.exports = { listTemplates, addTemplate, removeTemplate, listAssets, addAsset, removeAsset };
