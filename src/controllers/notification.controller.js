const service = require('../services/notification.service');

// Thin: shapes the HTTP envelope and nothing else. No try/catch — Express 5
// forwards rejected promises to errorHandler.

async function list(req, res) {
  const { rows, count } = await service.listInbox(req.user.userId, req.query);
  res.json({ success: true, data: rows, meta: { total: count } });
}

async function summary(req, res) {
  res.json({ success: true, data: await service.summary(req.user.userId) });
}

async function markRead(req, res) {
  res.json({ success: true, data: await service.markRead(req.user.userId, req.params.uid) });
}

async function markAllRead(req, res) {
  res.json({ success: true, data: await service.markAllRead(req.user.userId) });
}

async function dismiss(req, res) {
  res.json({ success: true, data: await service.dismiss(req.user.userId, req.params.uid) });
}

async function dismissAll(req, res) {
  res.json({ success: true, data: await service.dismissAll(req.user.userId) });
}

async function getSettings(req, res) {
  res.json({ success: true, data: await service.getSettings(req.user.userId) });
}

async function updateSettings(req, res) {
  res.json({ success: true, data: await service.updateSettings(req.user.userId, req.body.settings) });
}

module.exports = {
  list, summary, markRead, markAllRead, dismiss, dismissAll, getSettings, updateSettings,
};
