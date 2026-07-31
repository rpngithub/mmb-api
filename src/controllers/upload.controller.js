const uploadService = require('../services/upload.service');

const presign = async (req, res) => {
  res.json({ success: true, data: await uploadService.presign(req.body) });
};

const multipartInitiate = async (req, res) => {
  res.json({ success: true, data: await uploadService.multipartInitiate(req.body) });
};

const multipartPresignParts = async (req, res) => {
  res.json({ success: true, data: await uploadService.multipartPresignParts(req.body) });
};

const multipartComplete = async (req, res) => {
  res.json({ success: true, data: await uploadService.multipartComplete(req.body) });
};

const multipartAbort = async (req, res) => {
  res.json({ success: true, data: await uploadService.multipartAbort(req.body) });
};

const confirm = async (req, res) => {
  res.json({ success: true, data: await uploadService.confirm(req.body) });
};

module.exports = { presign, multipartInitiate, multipartPresignParts, multipartComplete, multipartAbort, confirm };
