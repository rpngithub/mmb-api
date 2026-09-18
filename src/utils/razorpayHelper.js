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
// Immediate, not at cycle end: the caller is the account purge, and an account
// that is about to be wiped must not take one more charge. Razorpay rejects
// cancellation of a subscription that is already cancelled/completed/expired;
// callers that may hit that should treat it as already done.
const cancelSubscription = (subscriptionId) =>
  getRazorpay().subscriptions.cancel(subscriptionId, /* cancelAtCycleEnd */ false);

// The user's own "cancel renewal": the paid term runs to its end and no further
// charge is taken. Razorpay fires subscription.cancelled when the cycle ends,
// which is what finally flips our row. There is no undo on the gateway side — a
// customer who changes their mind subscribes afresh.
const cancelSubscriptionAtCycleEnd = (subscriptionId) =>
  getRazorpay().subscriptions.cancel(subscriptionId, /* cancelAtCycleEnd */ true);

// HOW a captured payment was paid, from the payment entity Razorpay puts in
// payment.captured / order.paid / subscription.charged. Returns the two columns
// `payments` stores. The detail is for display only, so the instrument is
// masked here and the full value is never persisted.
const METHODS = new Set(['upi', 'card', 'netbanking', 'wallet', 'emi']);

const maskVpa = (vpa) => {
  const [handle, bank] = String(vpa).split('@');
  if (!bank) return null;
  return `${handle.slice(0, 2)}***@${bank}`;
};

const paymentMethodFrom = (entity) => {
  if (!entity?.method) return { payment_method: null, payment_method_detail: null };
  const method = METHODS.has(entity.method) ? entity.method : 'other';
  let detail = null;

  if (method === 'upi' && entity.vpa) {
    detail = `UPI · ${maskVpa(entity.vpa) || 'UPI'}`;
  } else if ((method === 'card' || method === 'emi') && entity.card) {
    const network = entity.card.network ? String(entity.card.network).toUpperCase() : 'Card';
    detail = entity.card.last4 ? `${network} •• ${entity.card.last4}` : network;
  } else if (method === 'netbanking' && entity.bank) {
    detail = `Netbanking · ${entity.bank}`;
  } else if (method === 'wallet' && entity.wallet) {
    detail = `Wallet · ${entity.wallet}`;
  }

  return { payment_method: method, payment_method_detail: detail ? detail.slice(0, 100) : null };
};

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

module.exports = {
  createOrder, createSubscription, cancelSubscription, cancelSubscriptionAtCycleEnd,
  paymentMethodFrom, verifyWebhookSignature, verifyPaymentSignature,
};
