const subscriptionService = require('../services/subscription.service');
const billingService      = require('../services/billing.service');

const listPlans = async (req, res) => {
  const plans = await subscriptionService.listPlans();
  res.json({ success: true, data: plans });
};

const verifyCoupon = async (req, res) => {
  const coupon = await subscriptionService.verifyCoupon(req.body.code, req.body.plan_id, req.user.userId);
  res.json({ success: true, data: coupon });
};

const mySubscription = async (req, res) => {
  const result = await subscriptionService.getMySubscription(req.user.userId);
  res.json({ success: true, data: result });
};

const initiate = async (req, res) => {
  const result = await subscriptionService.initiateSubscription(req.user.userId, req.body);
  res.status(201).json({ success: true, data: result });
};

const initiateAccessPass = async (req, res) => {
  const result = await subscriptionService.initiateAccessPass(req.user.userId);
  res.status(201).json({ success: true, data: result });
};

const verifyPayment = async (req, res) => {
  const result = await subscriptionService.verifyPayment(req.user.userId, req.body);
  res.json({ success: true, data: result });
};

// Public Razorpay webhook. Authenticated by HMAC signature over the raw body.
const webhook = async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const result    = await subscriptionService.handleWebhook(req.rawBody, signature);
  res.json({ success: true, ...result });
};

const cancelRenewal = async (req, res) => {
  const result = await subscriptionService.cancelRenewal(req.user.userId);
  res.json({ success: true, data: result });
};

const listPayments = async (req, res) => {
  const result = await billingService.listPayments(req.user.userId, req.query);
  res.json({ success: true, data: result });
};

// The one non-JSON response in the API: a print-ready HTML page. Inline, so a
// webview shows it; the FE decides whether to offer Print/Save.
const paymentDocument = async (req, res) => {
  const { html, filename } = await billingService.renderDocument(req.user.userId, req.params.uid, req.query.type || 'invoice');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.type('html').send(html);
};

module.exports = {
  listPlans, verifyCoupon, mySubscription, initiate, initiateAccessPass, verifyPayment, webhook,
  cancelRenewal, listPayments, paymentDocument,
};
