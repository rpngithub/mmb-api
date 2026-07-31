const authService = require('../services/auth.service');

const sendOtp = async (req, res) => {
  const result = await authService.sendOtpService(req.body);
  res.json({ success: true, data: result });
};

const verifyOtp = async (req, res) => {
  const result = await authService.verifyOtpService(req.body);
  res.json({ success: true, data: result });
};

const adminLogin = async (req, res) => {
  const tokens = await authService.loginAdmin(req.body);
  res.json({ success: true, data: tokens });
};

const refresh = async (req, res) => {
  const tokens = await authService.refreshTokens(req.body);
  res.json({ success: true, data: tokens });
};

const logout = async (req, res) => {
  const { jti, userId, actor_type, exp } = req.user;
  await authService.logout({ jti, userId, actorType: actor_type, expiresAt: new Date(exp * 1000) });
  res.json({ success: true, data: { message: 'Logged out' } });
};

module.exports = { sendOtp, verifyOtp, adminLogin, refresh, logout };
