const emailService = require('../services/email.service');

const sendVerification = async (req, res) => {
  res.json({ success: true, data: await emailService.sendVerification(req.user.userId) });
};

const verify = async (req, res) => {
  res.json({ success: true, data: await emailService.verify(req.body.token) });
};

const sendChangeOtp = async (req, res) => {
  res.json({ success: true, data: await emailService.sendChangeOtp(req.user.userId) });
};

const changeEmail = async (req, res) => {
  res.json({ success: true, data: await emailService.changeEmail(req, req.body) });
};

module.exports = { sendVerification, verify, sendChangeOtp, changeEmail };
