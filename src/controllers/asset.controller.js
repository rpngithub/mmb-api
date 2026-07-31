const assetService = require('../services/asset.service');

const list = async (req, res) => {
  const items = await assetService.listAssets(req.query, req.user);
  res.json({ success: true, data: items });
};

module.exports = { list };
