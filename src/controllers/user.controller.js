const userService    = require('../services/user.service');
const sessionService = require('../services/session.service');

const getProfile = async (req, res) => {
  const user = await userService.getProfile(req.user.userId);
  res.json({ success: true, data: user });
};

const updateProfile = async (req, res) => {
  const user = await userService.updateProfile(req.user.userId, req.body);
  res.json({ success: true, data: user });
};

// `sid` is the caller's own session — passed so it is the one session NOT ended
// when the password changes.
const changePassword = async (req, res) => {
  const result = await userService.changePassword(req.user.userId, req.body, req.user.sid);
  res.json({ success: true, data: { message: 'Password changed', ...result } });
};

const setPassword = async (req, res) => {
  const result = await userService.setPassword(req.user.userId, req.body, req.user.sid);
  res.json({ success: true, data: { message: 'Password set', ...result } });
};

const revokeOtherSessions = async (req, res) => {
  const ended = await sessionService.revokeOthers('user', req.user.userId, req.user.sid);
  res.json({ success: true, data: { message: 'Other devices signed out', sessions_ended: ended } });
};

const deactivate = async (req, res) => {
  const result = await userService.deactivate(req.user.userId);
  res.json({ success: true, data: { message: 'Account deactivated', ...result } });
};

const getPreferences = async (req, res) => {
  res.json({ success: true, data: await userService.getPreferences(req.user.userId) });
};

const updatePreferences = async (req, res) => {
  res.json({ success: true, data: await userService.updatePreferences(req.user.userId, req.body) });
};

const getBilling = async (req, res) => {
  const billing = await userService.getBilling(req.user.userId);
  res.json({ success: true, data: billing });
};

const upsertBilling = async (req, res) => {
  const billing = await userService.upsertBilling(req.user.userId, req.body);
  res.json({ success: true, data: billing });
};

module.exports = {
  getProfile, updateProfile, changePassword, setPassword, revokeOtherSessions, deactivate,
  getPreferences, updatePreferences, getBilling, upsertBilling,
};
