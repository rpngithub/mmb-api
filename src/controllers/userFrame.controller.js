const frameService = require('../services/userFrame.service');

const create = async (req, res) => {
  const frame = await frameService.createFrame(req.user.userId, req.body);
  res.status(201).json({ success: true, data: frame });
};

const list = async (req, res) => {
  const items = await frameService.listFrames(req.user.userId);
  res.json({ success: true, data: items });
};

const getOne = async (req, res) => {
  const frame = await frameService.getFrame(req.params.uid, req.user.userId);
  res.json({ success: true, data: frame });
};

const update = async (req, res) => {
  const frame = await frameService.updateFrame(req.params.uid, req.user.userId, req.body);
  res.json({ success: true, data: frame });
};

const remove = async (req, res) => {
  await frameService.deleteFrame(req.params.uid, req.user.userId);
  res.json({ success: true, data: null });
};

module.exports = { create, list, getOne, update, remove };
