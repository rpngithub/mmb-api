const userUpload = require('../services/userUpload.service');

const presign = async (req, res) => {
  res.json({ success: true, data: await userUpload.presign(req.body, req.user.userId) });
};

const confirm = async (req, res) => {
  res.json({ success: true, data: await userUpload.confirm(req.body, req.user.userId) });
};

const list = async (req, res) => {
  const result = await userUpload.listMine(req.user.userId, req.query);
  res.json({ success: true, data: result.rows, meta: { total: result.count } });
};

const remove = async (req, res) => {
  await userUpload.deleteMine(req.params.uid, req.user.userId);
  res.json({ success: true, data: null });
};

module.exports = { presign, confirm, list, remove };
