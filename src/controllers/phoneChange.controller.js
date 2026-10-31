const phoneChange = require('../services/phoneChange.service');

const options = async (req, res) => {
  res.json({ success: true, data: await phoneChange.options(req.user.userId) });
};

const start = async (req, res) => {
  res.json({ success: true, data: await phoneChange.start(req) });
};

const verifyOld = async (req, res) => {
  res.json({ success: true, data: await phoneChange.verifyOld(req.user.userId, req.params.uid, req.body) });
};

const submitNewPhone = async (req, res) => {
  res.json({ success: true, data: await phoneChange.submitNewPhone(req.user.userId, req.params.uid, req.body) });
};

const verifyNew = async (req, res) => {
  res.json({ success: true, data: await phoneChange.verifyNew(req, req.params.uid, req.body) });
};

const lostPhone = async (req, res) => {
  res.json({ success: true, data: await phoneChange.lostPhone(req) });
};

// The public, link-driven half ("Lost my mobile").
const inspectLink = async (req, res) => {
  res.json({ success: true, data: await phoneChange.inspectLink(req.params.token) });
};

const linkSendOtp = async (req, res) => {
  res.json({ success: true, data: await phoneChange.linkSendOtp(req.body) });
};

const linkVerify = async (req, res) => {
  res.json({ success: true, data: await phoneChange.linkVerify(req, req.body) });
};

module.exports = {
  options, start, verifyOld, submitNewPhone, verifyNew, lostPhone, inspectLink, linkSendOtp, linkVerify,
};
