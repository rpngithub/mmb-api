const { v4: uuid }      = require('uuid');
const { Op }            = require('sequelize');
const planRepo          = require('../repositories/plan.repository');
const subRepo           = require('../repositories/userSubscription.repository');
const couponRepo        = require('../repositories/coupon.repository');
const paymentRepo       = require('../repositories/payment.repository');
const quotaRepo         = require('../repositories/userQuotaUsage.repository');
const {
  createOrder, createSubscription, verifyWebhookSignature, verifyPaymentSignature,
} = require('../utils/razorpayHelper');
const { NotFoundError, AuthError, ForbiddenError, ConflictError } = require('../errors');
const { PlanBillingOption, Plan } = require('../models');

const GST_RATE = 0.18;

function addCycle(date, cycle) {
  const d = new Date(date);
  if (cycle === 'annual') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function withGst(amountBeforeTax) {
  const gstAmount   = parseFloat((amountBeforeTax * GST_RATE).toFixed(2));
  const totalAmount = parseFloat((amountBeforeTax + gstAmount).toFixed(2));
  return { gstAmount, totalAmount };
}

async function listPlans() {
  return planRepo.findAllActive();
}

// Every redemption rule the coupon row declares, in one place so the "check"
// endpoint and the actual redemption can never disagree. `findActiveByCode` has
// already covered status + the valid_from/valid_to window; this covers the rest.
// Throws on the first failure — the message is user-facing.
async function assertRedeemable(coupon, { planId, userId }) {
  if (coupon.max_uses != null && coupon.used_count >= coupon.max_uses) {
    throw new ConflictError('This coupon has reached its usage limit');
  }

  if (coupon.applicable_to === 'specific_plans' && !(await couponRepo.appliesToPlan(coupon.id, planId))) {
    throw new ConflictError('This coupon is not valid for the selected plan');
  }

  if (coupon.target_audience !== 'all') {
    const hasSubscribed = await subRepo.hasEverSubscribed(userId);
    if (coupon.target_audience === 'new_users' && hasSubscribed) {
      throw new ConflictError('This coupon is only valid for first-time subscribers');
    }
    if (coupon.target_audience === 'existing_users' && !hasSubscribed) {
      throw new ConflictError('This coupon is only valid for existing subscribers');
    }
  }
}

// What the coupon takes off a given base amount. Percentage is computed against
// the same base the customer is actually charged, and the discount can never
// exceed it (a fixed coupon worth more than the plan makes it free, not negative).
function discountFor(coupon, baseAmount) {
  const raw = coupon.discount_type === 'percentage'
    ? (baseAmount * parseFloat(coupon.discount_value)) / 100
    : parseFloat(coupon.discount_value);
  return Math.min(parseFloat(raw.toFixed(2)), baseAmount);
}

// Pre-checkout check for the FE's "apply coupon" box: same rules the redemption
// applies, so a coupon that verifies here cannot be rejected at checkout. Public-
// safe fields only (used_count/max_uses/target_audience stay internal).
async function verifyCoupon(code, planId, userId) {
  const coupon = await couponRepo.findActiveByCode(code);
  if (!coupon) throw new NotFoundError('Coupon not found or expired');
  await assertRedeemable(coupon, { planId, userId });

  return {
    uid:            coupon.uid,
    code:           coupon.code,
    title:          coupon.title,
    discount_type:  coupon.discount_type,
    discount_value: coupon.discount_value,
    valid_to:       coupon.valid_to,
  };
}

// Maps a feature key to its counter column on user_quota_usage (mirrors
// quota.service). Unlisted keys fall back to `<key>_count`.
const USAGE_FIELD = {
  downloads:      'downloads_count',
  shares:         'shares_count',
  template_views: 'template_views_count',
  ai_credits:     'ai_credits_used',
  storage:        'storage_used_bytes',
};

// Turns one plan_feature row into an FE-friendly entitlement. Booleans expose
// `enabled`; counters expose limit/used/remaining (value -1 = unlimited).
function buildFeature(pf, usage) {
  const ft   = pf.FeatureType;
  const base = { key: ft.key, label: ft.label, reset_period: ft.reset_period, data_type: ft.data_type };
  if (ft.data_type === 'boolean') return { ...base, enabled: pf.value === 1 };

  const unlimited = pf.value === -1;
  const field     = USAGE_FIELD[ft.key] || `${ft.key}_count`;
  const used      = usage ? Number(usage[field] ?? 0) : 0;
  return {
    ...base,
    limit:     unlimited ? null : pf.value,
    unlimited,
    used,
    remaining: unlimited ? null : Math.max(pf.value - used, 0),
  };
}

// The signed-in user's current subscription state — the endpoint the FE polls
// after checkout and reads to gate premium features. Only the ACTIVE row is
// returned (pending/expired/overridden are not); no active row = free tier.
async function getMySubscription(userId) {
  const sub = await subRepo.findActiveDetailed(userId);
  if (!sub) {
    return { has_active_subscription: false, is_on_trial: false, subscription: null, plan: null, billing: null, features: [] };
  }

  const usage    = await quotaRepo.findByUserId(userId);
  const plan     = sub.Plan;
  const option   = sub.PlanBillingOption;
  const features = (plan?.PlanFeatures || [])
    .filter((pf) => pf.FeatureType)
    .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
    .map((pf) => buildFeature(pf, usage));

  return {
    has_active_subscription: true,
    is_on_trial:             sub.sub_type === 'trial',
    subscription: {
      uid:         sub.uid,
      status:      sub.status,
      sub_type:    sub.sub_type,
      auto_renew:  !!sub.auto_renew,
      starts_at:   sub.starts_at,
      ends_at:     sub.ends_at,
      amount_paid: sub.amount_paid,
    },
    plan:    plan   ? { uid: plan.uid, name: plan.name, description: plan.description, plan_type: plan.plan_type } : null,
    billing: option ? { cycle: option.billing_cycle, price: option.price, currency: option.currency } : null,
    features,
  };
}

async function initiateSubscription(userId, { plan_billing_option_id, coupon_code }) {
  const option = await PlanBillingOption.findByPk(plan_billing_option_id);
  if (!option) throw new NotFoundError('Billing option not found');
  const plan = await Plan.findByPk(option.plan_id);

  const listPrice = parseFloat(option.discounted_price || option.price);

  // A bad coupon fails the request rather than silently charging full price —
  // the customer typed it expecting a discount. `used_count` is NOT bumped here;
  // it is bumped on activation (see _activate) so abandoned checkouts don't
  // consume a capped coupon.
  let discount = 0;
  let couponId = null;
  if (coupon_code) {
    const coupon = await couponRepo.findActiveByCode(coupon_code);
    if (!coupon) throw new NotFoundError('Coupon not found or expired');
    await assertRedeemable(coupon, { planId: option.plan_id, userId });
    couponId = coupon.id;
    discount = discountFor(coupon, listPrice);
  }

  const amountBeforeTax        = listPrice - discount;
  const { gstAmount, totalAmount } = withGst(amountBeforeTax);
  const startsAt               = new Date();

  // This plan offers a free trial -> the customer subscribes now (mandate) but
  // the first charge is deferred to the trial end. Requires a recurring Razorpay
  // plan; one trial per (user, plan).
  const isTrial = plan && plan.trial_days > 0;
  const endsAt  = isTrial ? addDays(startsAt, plan.trial_days) : addCycle(startsAt, option.billing_cycle);

  // A pending subscription is created up front for BOTH paths so the webhook /
  // callback only needs to flip it active (and we never lose the plan linkage).
  const baseSub = {
    uid:                    uuid(),
    user_id:                userId,
    plan_id:                option.plan_id,
    plan_billing_option_id: option.id,
    coupon_id:              couponId,
    sub_type:               isTrial ? 'trial' : 'regular',
    status:                 'pending',
    starts_at:              startsAt,
    ends_at:                endsAt,
    amount_paid:            totalAmount,
  };

  if (isTrial) {
    if (await subRepo.findTrialByUserAndPlan(userId, plan.id)) {
      throw new ConflictError('You have already used the free trial for this plan');
    }
    if (!option.razorpay_plan_id) {
      throw new ConflictError('This plan is not configured for trials (missing Razorpay plan mapping)');
    }
    const totalCount = option.billing_cycle === 'annual' ? 5 : 12;
    const startAt    = Math.floor(endsAt.getTime() / 1000); // first charge at trial end
    const rzpSub     = await createSubscription(option.razorpay_plan_id, totalCount, startAt);
    const sub        = await subRepo.create({ ...baseSub, auto_renew: 1, razorpay_subscription_id: rzpSub.id });
    return {
      type:                  'trial',
      trial_ends_at:         endsAt,
      subscription_id:       rzpSub.id,
      short_url:             rzpSub.short_url,
      user_subscription_uid: sub.uid,
    };
  }

  // Recurring auto-debit when the billing option is mapped to a Razorpay plan;
  // otherwise a one-time Orders-API charge.
  if (option.razorpay_plan_id) {
    const totalCount = option.billing_cycle === 'annual' ? 5 : 12;
    const rzpSub     = await createSubscription(option.razorpay_plan_id, totalCount);
    const sub        = await subRepo.create({ ...baseSub, auto_renew: 1, razorpay_subscription_id: rzpSub.id });
    return {
      type:                  'recurring',
      subscription_id:       rzpSub.id,
      short_url:             rzpSub.short_url,
      user_subscription_uid: sub.uid,
    };
  }

  const sub   = await subRepo.create({ ...baseSub, auto_renew: 0 });
  const order = await createOrder(totalAmount, 'INR', `sub_${Date.now()}`);
  const payment = await paymentRepo.create({
    uid:               uuid(),
    user_id:           userId,
    subscription_id:   sub.id,
    order_type:        'one_time',
    amount:            totalAmount,
    amount_before_tax: amountBeforeTax,
    gst_amount:        gstAmount,
    razorpay_order_id: order.id,
    status:            'pending',
  });

  return {
    type:                  'one_time',
    order_id:              order.id,
    amount:                totalAmount,
    currency:              'INR',
    payment_uid:           payment.uid,
    user_subscription_uid: sub.uid,
  };
}

// ₹10 one-time access pass: enjoy the access-pass plan's features for pass_days
// without subscribing, then it expires (the renewal job reverts the user to
// free). One pass per user, ever.
async function initiateAccessPass(userId) {
  if (await subRepo.findAccessPassByUser(userId)) {
    throw new ConflictError('You have already used your one-time access pass');
  }
  const plan = await planRepo.findAccessPass();
  if (!plan) throw new NotFoundError('No access pass is currently available');

  const amountBeforeTax            = parseFloat(plan.pass_price);
  const { gstAmount, totalAmount } = withGst(amountBeforeTax);
  const startsAt                   = new Date();

  const sub = await subRepo.create({
    uid:                    uuid(),
    user_id:                userId,
    plan_id:                plan.id,
    plan_billing_option_id: null,
    sub_type:               'access_pass',
    status:                 'pending',
    auto_renew:             0,
    starts_at:              startsAt,
    ends_at:                addDays(startsAt, plan.pass_days),
    amount_paid:            totalAmount,
  });

  const order   = await createOrder(totalAmount, 'INR', `pass_${Date.now()}`);
  const payment = await paymentRepo.create({
    uid:               uuid(),
    user_id:           userId,
    subscription_id:   sub.id,
    order_type:        'one_time',
    amount:            totalAmount,
    amount_before_tax: amountBeforeTax,
    gst_amount:        gstAmount,
    razorpay_order_id: order.id,
    status:            'pending',
  });

  return {
    type:                  'access_pass',
    order_id:              order.id,
    amount:                totalAmount,
    currency:              'INR',
    pass_days:             plan.pass_days,
    payment_uid:           payment.uid,
    user_subscription_uid: sub.uid,
  };
}

// Activate a pending/renewing subscription and demote any other active sub the
// user holds (so there is at most one active plan at a time). The access window
// depends on sub_type: trial -> trial_days, access_pass -> pass_days, otherwise
// one billing cycle.
async function _activate(subId) {
  const sub = await subRepo.findById(subId, { include: [{ model: PlanBillingOption }, { model: Plan }] });
  if (!sub) return;
  const wasActive = sub.status === 'active';
  const startsAt  = new Date();

  let endsAt;
  if (sub.sub_type === 'access_pass') endsAt = addDays(startsAt, sub.Plan?.pass_days || 0);
  else if (sub.sub_type === 'trial')  endsAt = addDays(startsAt, sub.Plan?.trial_days || 0);
  else                                endsAt = addCycle(startsAt, sub.PlanBillingOption?.billing_cycle || 'monthly');

  await subRepo.model.update(
    { status: 'overridden' },
    { where: { user_id: sub.user_id, status: 'active', id: { [Op.ne]: sub.id } } }
  );
  await subRepo.update(sub.id, { status: 'active', starts_at: startsAt, ends_at: endsAt });

  // Redemption is counted at activation, once. The `wasActive` guard keeps the
  // webhook and the client callback (either may land first, and the webhook may
  // be redelivered) from double-counting the same subscription.
  if (!wasActive && sub.coupon_id) await couponRepo.incrementUsage(sub.coupon_id);
}

// Synchronous client callback after Checkout. Verifies the payment signature
// and activates idempotently. The webhook remains the source of truth.
async function verifyPayment(userId, { razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    throw new AuthError('Invalid payment signature');
  }
  const payment = await paymentRepo.findByRazorpayOrderId(razorpay_order_id);
  if (!payment) throw new NotFoundError('Payment not found');
  if (payment.user_id !== userId) throw new ForbiddenError('Access denied');

  if (payment.status !== 'success') {
    await paymentRepo.update(payment.id, {
      status: 'success', razorpay_payment_id, razorpay_signature, paid_at: new Date(),
    });
    if (payment.subscription_id) await _activate(payment.subscription_id);
  }
  return { verified: true, payment_uid: payment.uid };
}

// ---- Webhook (source of truth) ----
async function handleWebhook(rawBody, signature) {
  if (!verifyWebhookSignature(rawBody, signature)) throw new AuthError('Invalid webhook signature');
  const event = JSON.parse(rawBody.toString('utf8')); // safe: only after signature passes

  switch (event.event) {
    case 'payment.captured':
    case 'order.paid':          return _onOneTimePaid(event);
    case 'subscription.activated': return _onSubActivated(event);
    case 'subscription.charged':   return _onSubCharged(event);
    case 'subscription.halted':
    case 'subscription.cancelled': return _onSubEnded(event);
    default:                       return { ignored: event.event };
  }
}

async function _onOneTimePaid(event) {
  const p = event.payload?.payment?.entity;
  if (!p?.order_id) return { ignored: 'no order_id' };

  const payment = await paymentRepo.findByRazorpayOrderId(p.order_id);
  if (!payment) return { ignored: 'unknown order' };
  if (payment.status === 'success') return { ok: true, idempotent: true };

  await paymentRepo.update(payment.id, { status: 'success', razorpay_payment_id: p.id, paid_at: new Date() });
  if (payment.subscription_id) await _activate(payment.subscription_id);
  return { ok: true };
}

async function _onSubActivated(event) {
  const s   = event.payload?.subscription?.entity;
  const sub = s && await subRepo.findByRazorpaySubscriptionId(s.id);
  if (!sub) return { ignored: 'unknown subscription' };
  if (sub.status === 'active') return { ok: true, idempotent: true };
  await _activate(sub.id);
  return { ok: true };
}

async function _onSubCharged(event) {
  const s   = event.payload?.subscription?.entity;
  const p   = event.payload?.payment?.entity;
  const sub = s && await subRepo.findByRazorpaySubscriptionId(s.id);
  if (!sub) return { ignored: 'unknown subscription' };

  if (p?.id) {
    const existing = await paymentRepo.findByRazorpayPaymentId(p.id);
    if (existing) return { ok: true, idempotent: true };
  }

  const amount    = (p?.amount || 0) / 100;
  const beforeTax = parseFloat((amount / (1 + GST_RATE)).toFixed(2));
  const gstAmount = parseFloat((amount - beforeTax).toFixed(2));
  await paymentRepo.create({
    uid: uuid(), user_id: sub.user_id, subscription_id: sub.id, order_type: 'subscription',
    amount, amount_before_tax: beforeTax, gst_amount: gstAmount,
    status: 'success', razorpay_payment_id: p?.id, paid_at: new Date(),
  });

  const cycle = sub.PlanBillingOption?.billing_cycle || 'monthly';
  const base  = sub.ends_at && new Date(sub.ends_at) > new Date() ? new Date(sub.ends_at) : new Date();
  // First real charge converts a trial into a regular recurring subscription;
  // ends_at extends from the trial end so no paid days are lost.
  await subRepo.update(sub.id, { status: 'active', sub_type: 'regular', ends_at: addCycle(base, cycle) });
  return { ok: true };
}

async function _onSubEnded(event) {
  const s   = event.payload?.subscription?.entity;
  const sub = s && await subRepo.findByRazorpaySubscriptionId(s.id);
  if (!sub) return { ignored: 'unknown subscription' };
  await subRepo.update(sub.id, { status: 'cancelled', cancelled_at: new Date() });
  return { ok: true };
}

module.exports = {
  listPlans, verifyCoupon, getMySubscription, initiateSubscription, initiateAccessPass, verifyPayment, handleWebhook,
};
