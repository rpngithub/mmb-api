const paymentRepo   = require('../repositories/payment.repository');
const billingRepo   = require('../repositories/userBillingDetail.repository');
const userRepo      = require('../repositories/user.repository');
const invoiceNumber = require('./invoiceNumber.service');
const document      = require('./billingDocument');
const { seller }    = require('../config/seller');
const { NotFoundError, ForbiddenError, ConflictError, ValidationError } = require('../errors');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 100;

// ---- Describing a payment ----

const CYCLE_LABEL = { monthly: 'Monthly', annual: 'Annual' };

// The one line that says what a payment bought — the history row's description
// and the invoice's line item. Resolved from whichever purchasable the payment
// is attached to (see payment.repository DESCRIBE). A purchasable that has been
// deleted since still yields something readable rather than a blank row.
function describe(payment) {
  const sub = payment.UserSubscription;
  if (payment.subscription_id) {
    const plan  = sub?.Plan?.name || 'Plan';
    if (sub?.sub_type === 'access_pass') return `${plan} – Access Pass`;
    const cycle = CYCLE_LABEL[sub?.PlanBillingOption?.billing_cycle];
    return cycle ? `${plan} – ${cycle} Plan` : `${plan} Plan`;
  }
  if (payment.purchase_type === 'quota_pack') {
    const pack = payment.UserQuotaGrant?.QuotaPack?.name;
    return pack ? `${pack} – Top-up` : 'Quota Top-up';
  }
  // NULL purchase_type predates the discriminator and was always a frame.
  const frame = payment.UserFrame?.Frame?.name;
  return frame ? `Frame – ${frame}` : 'Frame';
}

// The window a subscription payment bought, for the invoice line. Only the
// subscription row's CURRENT term is known, so this is right for the latest
// charge and best-effort for older renewals; standalone purchases have none.
function periodFor(payment) {
  const sub = payment.UserSubscription;
  if (!payment.subscription_id || !sub?.starts_at || !sub?.ends_at) return null;
  const f = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  return `${f(sub.starts_at)} – ${f(sub.ends_at)}`;
}

function toRow(payment) {
  const p = payment.toJSON ? payment.toJSON() : payment;
  return {
    uid:                   p.uid,
    description:           describe(payment),
    purchase_type:         p.purchase_type || (p.subscription_id ? 'subscription' : 'frame'),
    order_type:            p.order_type,
    // A successful payment is dated when it was paid; anything else, when it was
    // attempted.
    date:                  p.paid_at || p.created_at,
    amount:                Number(p.amount),
    amount_before_tax:     Number(p.amount_before_tax),
    gst_amount:            Number(p.gst_amount),
    currency:              p.currency,
    status:                p.status,
    payment_method:        p.payment_method,
    payment_method_detail: p.payment_method_detail,
    invoice_number:        p.invoice_number,
    razorpay_payment_id:   p.razorpay_payment_id,
    // Invoice and receipt exist only for money actually received.
    documents_available:   p.status === 'success',
  };
}

// ---- History ----

async function listPayments(userId, filters = {}) {
  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const page   = Math.max(parseInt(filters.page, 10) || 1, 1);
  const offset = (page - 1) * limit;

  const { rows, count } = await paymentRepo.findHistory(userId, { limit, offset });
  const items = rows.map(toRow);

  return {
    items,
    // The "Last transaction" card is the newest SUCCESSFUL row, not merely the
    // newest attempt — a failed retry is not a transaction.
    last_transaction: page === 1 ? (items.find((r) => r.status === 'success') || null) : undefined,
    pagination: { page, limit, total: count, total_pages: Math.max(Math.ceil(count / limit), 1) },
  };
}

// ---- Documents ----

const norm = (s) => String(s || '').trim().toLowerCase();

// Buyer block from the saved billing details when the user has filled them in
// (GSTIN, address — what a business needs on a tax invoice); otherwise the
// account's own name and contact, which is all a B2C invoice requires.
async function buyerFor(userId) {
  const detail = await billingRepo.findByUserId(userId);
  if (detail) {
    return {
      name: detail.billing_name, gstin: detail.gstin || null, address: detail.billing_address,
      state: detail.billing_state, pincode: detail.billing_pincode,
    };
  }
  const user = await userRepo.findById(userId);
  return { name: user?.name || 'Customer', email: user?.email || null, phone: user?.phone || null, state: null };
}

// CGST+SGST when the buyer is in the seller's state, IGST otherwise. With no
// billing address the place of supply for a service defaults to the supplier's
// location, i.e. intra-state. The amounts come straight off the payment row —
// this only decides how the recorded tax is labelled.
function taxFor(payment, buyer, sellerInfo) {
  const rate       = Number(payment.gst_rate);
  const amount     = Number(payment.gst_amount);
  const buyerState = norm(buyer.state);
  const intra      = !buyerState || !sellerInfo.state || buyerState === norm(sellerInfo.state);
  return {
    split:           intra ? 'intra' : 'inter',
    rate,
    amount,
    half_rate:       rate / 2,
    half_amount:     Number((amount / 2).toFixed(2)),
    place_of_supply: buyer.state || sellerInfo.state || null,
  };
}

async function renderDocument(userId, uid, type) {
  if (type !== 'invoice' && type !== 'receipt') {
    throw new ValidationError('Validation failed', [{ field: 'type', message: 'type must be invoice or receipt' }]);
  }

  const payment = await paymentRepo.findDescribedByUid(uid);
  if (!payment) throw new NotFoundError('Payment not found');
  if (payment.user_id !== userId) throw new ForbiddenError('Access denied');
  if (payment.status !== 'success') throw new ConflictError('Documents are available only for successful payments');

  // Rows that succeeded before invoice numbering existed get theirs now, dated
  // to when they were paid so they fall in the right financial year.
  const number = payment.invoice_number || await invoiceNumber.assign(payment.id, payment.paid_at || payment.created_at);

  const sellerInfo = seller();
  const buyer      = await buyerFor(userId);
  const data = {
    number,
    issued_at: payment.paid_at || payment.created_at,
    seller:    { ...sellerInfo, gstin_pending: !sellerInfo.gstin },
    buyer,
    payment:   { ...payment.toJSON(), method_label: document.methodLabel(payment) },
    line:      { description: describe(payment), period: periodFor(payment), coupon: payment.UserSubscription?.Coupon?.code || null },
    tax:       taxFor(payment, buyer, sellerInfo),
  };

  return {
    html:     type === 'invoice' ? document.invoice(data) : document.receipt(data),
    filename: `${type}-${number.replace(/\//g, '-')}.html`,
  };
}

module.exports = { listPayments, renderDocument, describe, toRow };
