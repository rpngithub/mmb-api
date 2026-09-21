const { v4: uuid }      = require('uuid');
const { Op }            = require('sequelize');
const planRepo          = require('../repositories/plan.repository');
const subRepo           = require('../repositories/userSubscription.repository');
const couponRepo        = require('../repositories/coupon.repository');
const paymentRepo       = require('../repositories/payment.repository');
const quota             = require('./quota.service');
const catalogService    = require('./catalog.service');
const frameService      = require('./frame.service');
const quotaPackService  = require('./quotaPack.service');
const notify            = require('./notification.service');
const invoiceNumber     = require('./invoiceNumber.service');
const dedupe            = require('../utils/dedupeKey');
// Namespace import for the gateway calls the suite needs to stub (see
// quotaPack.service for the same reason); the pure helpers are destructured.
const razorpay          = require('../utils/razorpayHelper');
const { verifyWebhookSignature, verifyPaymentSignature, paymentMethodFrom } = razorpay;
const { withGst, GST_RATE } = require('../utils/gst');
const { NotFoundError, AuthError, ForbiddenError, ConflictError, AppError } = require('../errors');
const { PlanBillingOption, Plan } = require('../models');

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

// The deprecated /subscriptions/plans alias. Delegates so it can never drift
// from the canonical /plans shape (card-ready `features`, merged coupons).
async function listPlans() {
  return catalogService.listPlans();
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

// The signed-in user's current subscription state — the endpoint the FE polls
// after checkout and reads to gate premium features. Only the ACTIVE row is
// returned (pending/expired/overridden are not); no active row = free tier.
//
// The per-feature entitlements come from `quota.service.usageSummary`, which also
// backs `GET /quota/usage`. Building them here as well is how the gate the app
// enforces and the numbers the Usage screen shows would come to disagree, and a
// user shown headroom they do not have is the worst version of that bug.
async function getMySubscription(userId) {
  const sub = await subRepo.findActiveDetailed(userId);
  if (!sub) {
    return { has_active_subscription: false, is_on_trial: false, subscription: null, plan: null, billing: null, features: [] };
  }

  const plan     = sub.Plan;
  const option   = sub.PlanBillingOption;
  const { features, period } = await quota.usageSummary(userId, { sub });

  // The subscription's payment method is that of its latest successful charge —
  // there is no separate "instrument on file" to read; the mandate lives at
  // Razorpay. Null for a trial that has not been charged yet, and for a payment
  // confirmed only by the client callback until the webhook fills it in.
  const lastPayment = await paymentRepo.findLatestSuccessForSubscription(sub.id);
  const autoRenew   = !!sub.auto_renew;

  return {
    has_active_subscription: true,
    is_on_trial:             sub.sub_type === 'trial',
    // The current usage window — the "resets on" date the Usage screen shows.
    // Null when the account has recorded nothing yet.
    period,
    subscription: {
      uid:         sub.uid,
      status:      sub.status,
      sub_type:    sub.sub_type,
      auto_renew:  autoRenew,
      starts_at:   sub.starts_at,
      ends_at:     sub.ends_at,
      // The date the next charge is taken, or null when nothing will renew —
      // the screen then labels ends_at "Expires on" instead.
      renews_on:   autoRenew ? sub.ends_at : null,
      // Set once the user (or the gateway) stopped renewal; access runs to ends_at.
      renewal_cancelled_at:   sub.cancelled_at,
      // Whether "Cancel renewal" applies: only a live recurring mandate can be stopped.
      cancel_renewal_allowed: autoRenew && !!sub.razorpay_subscription_id,
      amount_paid: sub.amount_paid,
      payment_gateway:       lastPayment ? 'razorpay' : null,
      payment_method:        lastPayment?.payment_method || null,
      payment_method_detail: lastPayment?.payment_method_detail || null,
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
    const rzpSub     = await razorpay.createSubscription(option.razorpay_plan_id, totalCount, startAt);
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
    const rzpSub     = await razorpay.createSubscription(option.razorpay_plan_id, totalCount);
    const sub        = await subRepo.create({ ...baseSub, auto_renew: 1, razorpay_subscription_id: rzpSub.id });
    return {
      type:                  'recurring',
      subscription_id:       rzpSub.id,
      short_url:             rzpSub.short_url,
      user_subscription_uid: sub.uid,
    };
  }

  const sub   = await subRepo.create({ ...baseSub, auto_renew: 0 });
  const order = await razorpay.createOrder(totalAmount, 'INR', `sub_${Date.now()}`);
  const payment = await paymentRepo.create({
    uid:               uuid(),
    user_id:           userId,
    subscription_id:   sub.id,
    order_type:        'one_time',
    purchase_type:     'subscription',
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

  const order   = await razorpay.createOrder(totalAmount, 'INR', `pass_${Date.now()}`);
  const payment = await paymentRepo.create({
    uid:               uuid(),
    user_id:           userId,
    subscription_id:   sub.id,
    order_type:        'one_time',
    purchase_type:     'subscription',
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

  // Tell the user. Rides the same `wasActive` guard, and the dedupe key is scoped
  // to the subscription row, so a redelivered webhook cannot produce a second
  // "your plan is active" a day later. Fire-and-forget on purpose — see notify().
  if (!wasActive) {
    const planName = sub.Plan?.name || 'Premium';
    if (sub.sub_type === 'trial') {
      notify.notify({
        code: 'trial_activated', userId: sub.user_id,
        variables: { trial_days: sub.Plan?.trial_days || 7, plan_name: planName },
        dedupeKey: dedupe.forEntity('trial_activated', 'sub', sub.id),
      });
    } else {
      notify.notify({
        code: 'payment_successful', userId: sub.user_id,
        variables: { plan_name: planName },
        dedupeKey: dedupe.forEntity('payment_successful', 'sub', sub.id),
      });
    }
  }
}

// Deliver whatever a successful payment bought. Both callers below (client
// callback and webhook) route through here so a new purchasable never has to be
// wired into two places — and both are already guarded by the
// `status !== 'success'` check above, which is what makes this idempotent.
//
// This used to infer the purchasable from absence: "no subscription_id means a
// frame". That held only while frames were the sole standalone purchase, so
// `payments.purchase_type` now records what was bought instead. NULL still routes
// to frames — every pre-discriminator standalone payment was one — which is what
// lets an order created before the migration still fulfil after it.
async function _fulfil(payment) {
  if (payment.subscription_id) return _activate(payment.subscription_id);
  if (payment.purchase_type === 'quota_pack') return quotaPackService.fulfilPayment(payment);
  return frameService.fulfilPayment(payment);
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
    await _numberInvoice(payment.id);
    await _fulfil(payment);
  }
  return { verified: true, payment_uid: payment.uid };
}

// A payment that has succeeded is a supply, and a supply gets an invoice number
// — at that moment, so the sequence stays in date order. Numbering failing must
// never fail the confirmation that money was received: the document endpoint
// backfills a missing number on first request.
async function _numberInvoice(paymentId, issuedAt = new Date()) {
  try { await invoiceNumber.assign(paymentId, issuedAt); }
  catch (err) { console.error('[Billing] invoice numbering failed for payment', paymentId, err.message); }
}

// ---- Webhook (source of truth) ----
async function handleWebhook(rawBody, signature) {
  if (!verifyWebhookSignature(rawBody, signature)) throw new AuthError('Invalid webhook signature');
  const event = JSON.parse(rawBody.toString('utf8')); // safe: only after signature passes

  switch (event.event) {
    case 'payment.captured':
    case 'order.paid':          return _onOneTimePaid(event);
    case 'payment.failed':      return _onPaymentFailed(event);
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
  if (payment.status === 'success') {
    // The client callback got here first and it carries no method — the webhook
    // is the only source for HOW it was paid, so that part is still ours to do.
    if (!payment.payment_method && p.method) await paymentRepo.update(payment.id, paymentMethodFrom(p));
    return { ok: true, idempotent: true };
  }

  await paymentRepo.update(payment.id, {
    status: 'success', razorpay_payment_id: p.id, paid_at: new Date(), ...paymentMethodFrom(p),
  });
  await _numberInvoice(payment.id);
  await _fulfil(payment);
  return { ok: true };
}

// `payment.failed` was previously unhandled and fell through to `ignored`. It is
// handled now purely to tell the user — the payment row is deliberately NOT marked
// failed here, because Razorpay can retry the same order and a later
// `payment.captured` for it must still fulfil. Notifying is safe either way: the
// dedupe key is the razorpay payment id, so a redelivered failure is silent, and a
// subsequent success sends its own "plan is active" notification.
async function _onPaymentFailed(event) {
  const p = event.payload?.payment?.entity;
  if (!p?.order_id) return { ignored: 'no order_id' };

  const payment = await paymentRepo.findByRazorpayOrderId(p.order_id);
  if (!payment) return { ignored: 'unknown order' };
  if (payment.status === 'success') return { ok: true, ignored: 'already paid' };

  notify.notify({
    code: 'payment_failed', userId: payment.user_id,
    dedupeKey: dedupe.forEntity('payment_failed', 'pay', p.id || payment.id),
  });
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

  // Razorpay sends `subscription.charged` for the FIRST payment too, alongside
  // `subscription.activated`, and in either order. Treating that first charge
  // as a renewal granted two cycles for one payment (activated: now+1 cycle;
  // charged: ends_at+1 cycle — and the pending row's ends_at is already a cycle
  // out, so charged-first doubled it just the same). A recurring row with no
  // successful payment yet is on its first charge; a trial converts from its
  // trial end instead, since that is where the paid days begin. Read before
  // this charge's own row is written below.
  const isFirstCharge = sub.sub_type !== 'trial' && !(await paymentRepo.findLatestSuccessForSubscription(sub.id));

  const amount    = (p?.amount || 0) / 100;
  const beforeTax = parseFloat((amount / (1 + GST_RATE)).toFixed(2));
  const gstAmount = parseFloat((amount - beforeTax).toFixed(2));
  const payment   = await paymentRepo.create({
    uid: uuid(), user_id: sub.user_id, subscription_id: sub.id, order_type: 'subscription', purchase_type: 'subscription',
    amount, amount_before_tax: beforeTax, gst_amount: gstAmount,
    status: 'success', razorpay_payment_id: p?.id, paid_at: new Date(),
    // Razorpay's own invoice for this charge — kept for reconciliation only.
    razorpay_invoice_id: p?.invoice_id || null,
    ...paymentMethodFrom(p),
  });
  await _numberInvoice(payment.id);

  if (isFirstCharge) {
    // Same window `subscription.activated` sets (now + one cycle), so the two
    // events agree whichever lands first. _activate's own guard keeps the
    // coupon count and the "plan is active" notification to one.
    await _activate(sub.id);
    return { ok: true };
  }

  const cycle = sub.PlanBillingOption?.billing_cycle || 'monthly';
  const base  = sub.ends_at && new Date(sub.ends_at) > new Date() ? new Date(sub.ends_at) : new Date();
  // First real charge converts a trial into a regular recurring subscription;
  // ends_at extends from the trial end so no paid days are lost.
  await subRepo.update(sub.id, { status: 'active', sub_type: 'regular', ends_at: addCycle(base, cycle) });

  // Keyed on the razorpay payment id so each CHARGE notifies once — the
  // subscription id would only ever fire on the first renewal.
  notify.notify({
    code: 'subscription_renewed', userId: sub.user_id,
    dedupeKey: dedupe.forEntity('subscription_renewed', 'pay', p?.id || `${sub.id}-${Date.now()}`),
  });
  return { ok: true };
}

async function _onSubEnded(event) {
  const s   = event.payload?.subscription?.entity;
  const sub = s && await subRepo.findByRazorpaySubscriptionId(s.id);
  if (!sub) return { ignored: 'unknown subscription' };
  // A row the renewal job already expired (the user cancelled at cycle end and
  // the timer beat the webhook) is left as it is — both are terminal, and
  // flipping it would only churn the audit trail.
  if (sub.status === 'cancelled' || sub.status === 'expired') return { ok: true, idempotent: true };
  // cancelled_at was stamped when the USER asked to stop renewing; the webhook
  // that closes the mandate at cycle end must not move it to today.
  await subRepo.update(sub.id, { status: 'cancelled', auto_renew: 0, cancelled_at: sub.cancelled_at || new Date() });
  return { ok: true };
}

// ---- Cancel renewal ----

// "Stop charging me, but let me use what I paid for." The mandate is told to
// cancel at cycle end, so the paid term runs out naturally: the row stays
// active with auto_renew off, the renewal job expires it at ends_at (it only
// looks at auto_renew=0 rows), and Razorpay's own subscription.cancelled
// arrives around the same time. There is no undo — Razorpay does not reinstate
// a cancel-at-cycle-end — so a change of heart is a fresh subscription, and the
// response says so.
async function cancelRenewal(userId) {
  const sub = await subRepo.findActiveByUser(userId);
  if (!sub) throw new NotFoundError('No active subscription');

  // One-time plans and the access pass never renew; a second click on a
  // subscription already winding down is a no-op, not an error.
  if (!sub.auto_renew) {
    if (sub.cancelled_at) return _cancelRenewalResult(sub, { idempotent: true });
    throw new ConflictError('This subscription does not auto-renew');
  }
  if (!sub.razorpay_subscription_id) {
    throw new ConflictError('This subscription has no recurring mandate to cancel');
  }

  try {
    await razorpay.cancelSubscriptionAtCycleEnd(sub.razorpay_subscription_id);
  } catch (err) {
    // Razorpay refuses to cancel what is already cancelled/completed/expired —
    // which means renewal has in fact stopped, and our row should say so. Any
    // other failure is the gateway's, and the user must not be told renewal is
    // off while the mandate is still live.
    const desc = String(err?.error?.description || err?.message || '');
    if (!/cancel|completed|expired/i.test(desc)) {
      throw new AppError('Could not stop renewal with the payment gateway; please try again', 502, 'GATEWAY_ERROR');
    }
  }

  await subRepo.update(sub.id, { auto_renew: 0, cancelled_at: new Date() });

  // Confirm it in the inbox: no further charge, access until the term ends.
  // Keyed on the subscription row — a mandate is cancelled once — so a retry
  // after a gateway "already cancelled" cannot post it twice.
  const plan = await Plan.findByPk(sub.plan_id, { attributes: ['name'] });
  notify.notify({
    code: 'renewal_cancelled', userId,
    variables: {
      plan_name:    plan?.name || 'Premium',
      access_until: new Date(sub.ends_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
    },
    dedupeKey: dedupe.forEntity('renewal_cancelled', 'sub', sub.id),
  });

  return _cancelRenewalResult(await subRepo.findById(sub.id));
}

function _cancelRenewalResult(sub, extra = {}) {
  return {
    ...extra,
    subscription_uid:     sub.uid,
    auto_renew:           false,
    access_until:         sub.ends_at,
    renewal_cancelled_at: sub.cancelled_at,
    can_resume:           false,
  };
}

module.exports = {
  listPlans, verifyCoupon, getMySubscription, initiateSubscription, initiateAccessPass, verifyPayment, handleWebhook,
  cancelRenewal,
};
