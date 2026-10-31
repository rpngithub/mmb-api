const { v4: uuid }  = require('uuid');
const { User, Variant, UserVariant, BrandSeries, VariantBadge } = require('../models');
const paymentRepo   = require('../repositories/payment.repository');
const variantAccess = require('./variantAccess.service');
const variantQuota  = require('./variantQuota.service');
// Imported as a namespace, not destructured: the gateway has no test double, so
// the suite swaps this function out at call time.
const razorpay      = require('../utils/razorpayHelper');
const { withGst }   = require('../utils/gst');
const { NotFoundError, ForbiddenError, ConflictError, ValidationError } = require('../errors');

// Buying a variant outright — the way into a variant beside "Add to your Business"
// (see variantAccess.service). Open to any BUSINESS account:
//   - without a subscription, always;
//   - with one, only once the Brand Series quota is full — until then the variant is
//     added to the business instead (decided 2026-10-28).
//
// Deliberately outside the quota system: nothing here asserts or consumes the
// `brand_series` meter. That meter counts business_variants, and a purchase lives in
// user_variants, so it can never count against the plan allowance either.

// Why the viewer cannot buy what they already reach, in the words the app shows.
const ALREADY = {
  purchased: 'You already own this variant',
  added:     'This variant is already added to your business',
};

// The price fields every variant card carries. `is_purchasable` is the one the app
// keys the Buy button on; `total_price` is what Razorpay will actually ask for.
function priceFields(variant) {
  const price = variant.price === null || variant.price === undefined ? null : parseFloat(variant.price);
  const card  = {
    price,
    strike_price:   variant.strike_price === null || variant.strike_price === undefined ? null : parseFloat(variant.strike_price),
    is_purchasable: price !== null && price > 0,
    gst_amount:     null,
    total_price:    null,
  };
  if (card.is_purchasable) {
    const { gstAmount, totalAmount } = withGst(price);
    card.gst_amount  = gstAmount;
    card.total_price = totalAmount;
  }
  return card;
}

// Create the Razorpay order for a variant. The ownership row is written up front as
// 'pending' with the payment attached and flips to 'active' when Razorpay confirms —
// the shape frames use, which is what lets the existing webhook fulfil it.
async function purchaseVariant(uid, userId) {
  const variant = await Variant.findOne({ where: { uid, is_active: 1 } });
  if (!variant) throw new NotFoundError('Variant not found');

  const user = await User.findByPk(userId, { attributes: ['id', 'account_type'] });
  if (user?.account_type !== 'business') {
    throw new ForbiddenError('Only business accounts can buy a variant');
  }

  if (!priceFields(variant).is_purchasable) throw new ValidationError('This variant is not for sale');

  // Never charge for access the viewer already has, whichever way they have it.
  const via = (await variantAccess.accessVia([variant.id], { userId })).get(variant.id);
  if (via) throw new ConflictError(ALREADY[via]);

  // A subscriber with Brand Series slots left adds it; buying starts when they run out.
  const slots = await variantQuota.state(userId);
  if (slots.subscribed && !slots.full) {
    throw new ConflictError('Your plan still has Brand Series slots — add this variant to your business instead');
  }

  const amountBeforeTax            = parseFloat(variant.price);
  const { gstAmount, totalAmount } = withGst(amountBeforeTax);

  const order   = await razorpay.createOrder(totalAmount, 'INR', `variant_${Date.now()}`);
  const payment = await paymentRepo.create({
    uid:               uuid(),
    user_id:           userId,
    subscription_id:   null,
    order_type:        'one_time',
    purchase_type:     'variant',
    amount:            totalAmount,
    amount_before_tax: amountBeforeTax,
    gst_amount:        gstAmount,
    razorpay_order_id: order.id,
    status:            'pending',
  });

  // An abandoned checkout left a pending row; the unique index allows only one, so
  // repoint it at the new payment rather than adding another.
  const existing = await UserVariant.findOne({ where: { user_id: userId, variant_id: variant.id } });
  if (existing) {
    await existing.update({ payment_id: payment.id, status: 'pending' });
  } else {
    await UserVariant.create({
      uid: uuid(), user_id: userId, variant_id: variant.id, payment_id: payment.id, status: 'pending',
    });
  }

  return {
    type:        'one_time',
    order_id:    order.id,
    amount:      totalAmount,
    currency:    'INR',
    payment_uid: payment.uid,
    variant_uid: variant.uid,
  };
}

// Called by the payment layer once a one-time variant payment succeeds. Idempotent:
// a row already active (webhook and client callback both landed) is a no-op.
async function fulfilPayment(payment) {
  const row = await UserVariant.findOne({ where: { payment_id: payment.id } });
  if (!row) return { ignored: 'not a variant purchase' };
  if (row.status === 'active') return { ok: true, idempotent: true };

  await row.update({ status: 'active', acquired_at: new Date() });
  return { ok: true };
}

// "My variants" — what the caller has bought, newest first. Pending checkouts are
// not included: they grant nothing yet.
async function listMine(userId) {
  const rows = await UserVariant.findAll({
    where:   { user_id: userId, status: 'active' },
    include: [{
      model:   Variant,
      include: [
        { model: BrandSeries,  attributes: ['id', 'uid', 'slug', 'name', 'icon_s3_key', 'caption'] },
        { model: VariantBadge, attributes: ['id', 'uid', 'slug', 'name', 'icon_s3_key'] },
      ],
    }],
    order: [['acquired_at', 'DESC'], ['id', 'DESC']],
  });
  return rows.map((r) => {
    // payment_id is plumbing between the purchase and the webhook, not for clients.
    const { Variant: v, payment_id: _payment, ...own } = r.toJSON();
    return { ...own, Variant: v ? { ...v, ...priceFields(v) } : null };
  });
}

// ---- What the card offers ----

// The per-viewer facts `cta` needs, loaded ONCE per request rather than per card.
async function ctaContext(viewer) {
  if (!viewer?.userId) return { signedIn: false };
  const user  = await User.findByPk(viewer.userId, { attributes: ['account_type'] });
  const slots = await variantQuota.state(viewer.userId);
  return {
    signedIn:   true,
    isBusiness: user?.account_type === 'business',
    subscribed: slots.subscribed,
    full:       slots.full,
  };
}

// The one action a variant card should offer this viewer, so the website and app do
// not each re-derive the rules:
//   use       — already theirs (bought, or added while subscribed)
//   add       — subscriber with Brand Series slots left: "Add to your Business"
//   buy       — business account with no subscription, or a subscriber whose slots
//               are full, and the variant has a price
//   upgrade   — subscriber with full slots and the variant is not for sale
//   subscribe — business account, no subscription, variant not for sale
//   sign_in   — guest
//   null      — nothing applies (a personal account: no business to add it to, and
//               buying is for business accounts)
function cta(variant, accessVia, ctx) {
  if (accessVia)       return 'use';
  if (!ctx.signedIn)   return 'sign_in';
  if (!ctx.isBusiness) return null;
  const forSale = priceFields(variant).is_purchasable;
  if (ctx.subscribed && !ctx.full) return 'add';
  if (forSale)                     return 'buy';
  return ctx.subscribed ? 'upgrade' : 'subscribe';
}

module.exports = { purchaseVariant, fulfilPayment, listMine, priceFields, ctaContext, cta };
