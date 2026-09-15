const crypto      = require('crypto');
const getRazorpay = require('../config/razorpay');

const createOrder = (amount, currency = 'INR', receipt) =>
  getRazorpay().orders.create({ amount: Math.round(amount * 100), currency, receipt });

// startAt (Unix seconds) defers the first charge — used for free trials so the
// customer authorizes a mandate now but is only billed when the trial ends.
const createSubscription = (planId, totalCount = 12, startAt) => {
  const params = { plan_id: planId, total_count: totalCount };
  if (startAt) params.start_at = startAt;
  return getRazorpay().subscriptions.create(params);
};

// Stops a recurring subscription (UPI Autopay / card mandate) at Razorpay.
// Immediate, not at cycle end: the only caller today is the account purge, and
// an account that is about to be wiped must not take one more charge. Razorpay
// rejects cancellation of a subscription that is already cancelled/completed/
// expired; callers that may hit that should treat it as already done.
const cancelSubscription = (subscriptionId) =>
  getRazorpay().subscriptions.cancel(subscriptionId, /* cancelAtCycleEnd */ false);

// Razorpay signs the RAW request bytes — pass the raw Buffer/string, never a
// re-serialized object (JSON.stringify reorders/spaces keys and breaks the HMAC).
const verifyWebhookSignature = (rawBody, signature) => {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || '')
    .update(rawBody)
    .digest('hex');
  return expected === signature;
};

const verifyPaymentSignature = (orderId, paymentId, signature) => {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
};

module.exports = { createOrder, createSubscription, cancelSubscription, verifyWebhookSignature, verifyPaymentSignature };
