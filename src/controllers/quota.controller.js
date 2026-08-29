const quotaPackService = require('../services/quotaPack.service');
const quota            = require('../services/quota.service');

const listPacks = async (req, res) => {
  const items = await quotaPackService.listStore(req.query);
  res.json({ success: true, data: items, meta: { total: items.length } });
};

const getPack = async (req, res) => {
  const pack = await quotaPackService.getPack(req.params.uid);
  res.json({ success: true, data: pack });
};

// The Usage screen. `withBreakdown` is on here and off for /subscriptions/me:
// this screen is opened deliberately, that one is polled.
const usage = async (req, res) => {
  const data = await quota.usageSummary(req.user.userId, { withBreakdown: true });
  res.json({ success: true, data });
};

const purchase = async (req, res) => {
  const order = await quotaPackService.purchasePack(req.params.uid, req.user.userId);
  res.status(201).json({ success: true, data: order });
};

module.exports = { listPacks, getPack, usage, purchase };
