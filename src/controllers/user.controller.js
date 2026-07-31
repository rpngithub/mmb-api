const userService = require('../services/user.service');

const getProfile = async (req, res) => {
  const user = await userService.getProfile(req.user.userId);
  res.json({ success: true, data: user });
};

const updateProfile = async (req, res) => {
  const user = await userService.updateProfile(req.user.userId, req.body);
  res.json({ success: true, data: user });
};

const changePassword = async (req, res) => {
  await userService.changePassword(req.user.userId, req.body);
  res.json({ success: true, data: { message: 'Password changed' } });
};

const getBilling = async (req, res) => {
  const billing = await userService.getBilling(req.user.userId);
  res.json({ success: true, data: billing });
};

const upsertBilling = async (req, res) => {
  const billing = await userService.upsertBilling(req.user.userId, req.body);
  res.json({ success: true, data: billing });
};

module.exports = { getProfile, updateProfile, changePassword, getBilling, upsertBilling };
