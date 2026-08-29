const frameService = require('../services/frame.service');

const list = async (req, res) => {
  const { total, items } = await frameService.listStore(req.query, req.user || null);
  res.json({ success: true, data: items, meta: { total } });
};

const listCategories = async (req, res) => {
  res.json({ success: true, data: await frameService.listCategories() });
};

const getOne = async (req, res) => {
  const frame = await frameService.getFrame(req.params.uid, req.user || null);
  res.json({ success: true, data: frame });
};

const listMine = async (req, res) => {
  res.json({ success: true, data: await frameService.listMine(req.user.userId) });
};

const add = async (req, res) => {
  const owned = await frameService.addFrame(req.params.uid, req.user.userId);
  res.status(201).json({ success: true, data: owned });
};

const purchase = async (req, res) => {
  const order = await frameService.purchaseFrame(req.params.uid, req.user.userId);
  res.status(201).json({ success: true, data: order });
};

const remove = async (req, res) => {
  await frameService.removeFrame(req.params.uid, req.user.userId);
  res.json({ success: true, data: null });
};

module.exports = { list, listCategories, getOne, listMine, add, purchase, remove };
