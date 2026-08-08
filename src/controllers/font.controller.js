const fontService = require('../services/font.service');

const list = async (req, res) => {
  res.json({ success: true, data: await fontService.listFonts(req.query, req.user) });
};

const createOwn = async (req, res) => {
  const font = await fontService.createOwnFont(req.user.userId, req.body);
  res.status(201).json({ success: true, data: font });
};

const removeOwn = async (req, res) => {
  await fontService.deleteOwnFont(req.params.uid, req.user.userId);
  res.json({ success: true, data: null });
};

module.exports = { list, createOwn, removeOwn };
