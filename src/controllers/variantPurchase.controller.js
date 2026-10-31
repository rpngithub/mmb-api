const variantPurchase = require('../services/variantPurchase.service');

const purchase = async (req, res) => {
  const order = await variantPurchase.purchaseVariant(req.params.uid, req.user.userId);
  res.status(201).json({ success: true, data: order });
};

const listMine = async (req, res) => {
  res.json({ success: true, data: await variantPurchase.listMine(req.user.userId) });
};

module.exports = { purchase, listMine };
