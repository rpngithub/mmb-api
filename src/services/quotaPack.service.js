const { v4: uuid }    = require('uuid');
const packRepo        = require('../repositories/quotaPack.repository');
const grantRepo       = require('../repositories/userQuotaGrant.repository');
const featureTypeRepo = require('../repositories/featureType.repository');
const paymentRepo     = require('../repositories/payment.repository');
const userRepo        = require('../repositories/user.repository');
const userSubRepo     = require('../repositories/userSubscription.repository');
const quota           = require('./quota.service');
const quotaPackPublish = require('./quotaPackPublish');
// Imported as a namespace, not destructured: the gateway has no test double, so
// the suite swaps this function out at call time.
const razorpay        = require('../utils/razorpayHelper');
const { withGst }     = require('../utils/gst');
const { isRelaxed }   = require('../config/quota');
const { NotFoundError, ConflictError, ValidationError } = require('../errors');

const DEFAULT_LIMIT = 30;
const MAX_LIMIT     = 100;

// The store card. Prices are stored pre-tax (utils/gst.js), so the card carries
// the tax-inclusive total too — otherwise the figure on the card would not be the
// figure Razorpay asks for, which is the one complaint a store cannot afford.
function toCard(row) {
  const p  = row.toJSON();
  const ft = p.FeatureType || null;
  const { gstAmount, totalAmount } = withGst(parseFloat(p.price || 0));

  return {
    ...p,
    feature: ft ? { key: ft.key, label: ft.label, unit: quota.scaleFor(ft.key) === 1 ? 'count' : 'MB' } : null,
    gst_amount:  gstAmount,
    total_price: totalAmount,
  };
}

// ---- Store ----

// The packs on sale for one feature. A short curated shelf like the frames store,
// so the whole active set comes back in display order.
async function listStore(filters = {}) {
  const where = { status: 'active' };

  if (filters.feature) {
    const ft = await featureTypeRepo.findByKey(String(filters.feature));
    // An unknown feature key returns an EMPTY shelf, never the whole store —
    // the same rule the frames and template catalogues follow for a bad slug.
    where.feature_type_id = ft ? ft.id : 0;
  }

  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const rows = await packRepo.findForStore(where, { limit, offset });
  return rows.map(toCard);
}

async function getPack(uid) {
  const pack = await packRepo.findActiveByUid(uid);
  if (!pack) throw new NotFoundError('Quota pack not found');
  return toCard(pack);
}

// ---- Purchase ----

// Buy a pack. The grant row is written up front as 'pending' with the payment
// attached and flips to 'active' when Razorpay confirms — the same shape frames
// and subscriptions use, which is what lets the existing webhook fulfil this
// without knowing anything about quota.
async function purchasePack(uid, userId) {
  const pack = await packRepo.findActiveByUid(uid);
  if (!pack) throw new NotFoundError('Quota pack not found');

  const ft = pack.FeatureType;
  if (!ft || Number(ft.is_topupable) !== 1) {
    throw new ValidationError('This feature cannot be topped up');
  }

  // Refuse a sale that would buy nothing. `limitFor` returns null in exactly the
  // cases where extra headroom is meaningless, and distinguishing them is worth it
  // because the fix is different for each.
  if ((await quota.limitFor(userId, ft.key)) === null) {
    // Enforcement suspended for this feature entirely (config/quota.js). Nobody
    // can hit a wall, so selling headroom would be taking money for nothing —
    // and blaming the customer's plan for it would be a lie.
    if (isRelaxed(ft.key)) {
      throw new ConflictError(`${ft.label} is not currently limited — there is nothing to top up`);
    }

    const sub = await userSubRepo.findActiveByUser(userId);
    throw new ConflictError(sub
      // The label as authored, not lower-cased: these are product names, and
      // "unlimited storage (mb)" reads like a typo where "Storage (MB)" does not.
      ? `Your plan already includes unlimited ${ft.label}`
      : 'Top-ups apply to paid plans — subscribe first');
  }

  const amountBeforeTax            = parseFloat(pack.price);
  const { gstAmount, totalAmount } = withGst(amountBeforeTax);

  const order   = await razorpay.createOrder(totalAmount, 'INR', `quota_${Date.now()}`);
  const payment = await paymentRepo.create({
    uid:               uuid(),
    user_id:           userId,
    subscription_id:   null,
    order_type:        'one_time',
    purchase_type:     'quota_pack',
    amount:            totalAmount,
    amount_before_tax: amountBeforeTax,
    gst_amount:        gstAmount,
    razorpay_order_id: order.id,
    status:            'pending',
  });

  // A NEW grant row every time, deliberately unlike a frame's single ownership
  // row: buying the same pack twice must credit twice. An abandoned attempt
  // leaves a `pending` row behind, which contributes nothing to the balance.
  await grantRepo.create({
    uid:             uuid(),
    user_id:         userId,
    feature_type_id: ft.id,
    quota_pack_id:   pack.id,
    // Snapshotted, not read back through quota_pack_id: editing the pack later
    // must not change what this purchase granted.
    quantity:        pack.quantity,
    source:          'purchase',
    payment_id:      payment.id,
    status:          'pending',
  });

  return {
    type:        'one_time',
    order_id:    order.id,
    amount:      totalAmount,
    currency:    'INR',
    payment_uid: payment.uid,
    pack_uid:    pack.uid,
  };
}

// Called by the payment layer once a one-time payment for a pack succeeds.
// Idempotent: a grant that is already active (webhook and client callback both
// landed) is a no-op, and a payment that bought nothing pack-shaped is ignored.
async function fulfilPayment(payment) {
  const grant = await grantRepo.findByPaymentId(payment.id);
  if (!grant) return { ignored: 'not a quota pack purchase' };
  if (grant.status === 'active') return { ok: true, idempotent: true };
  // A revoked grant must never be resurrected by a redelivered webhook.
  if (grant.status !== 'pending') return { ignored: `grant is ${grant.status}` };

  await grantRepo.update(grant.id, { status: 'active', granted_at: new Date() });
  return { ok: true };
}

// ---- Admin ----

async function listForAdmin(filters = {}) {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.feature_type_id) where.feature_type_id = filters.feature_type_id;

  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const { rows, count } = await packRepo.findForAdmin(where, { limit, offset });

  return {
    count,
    rows: rows.map((row) => {
      const p  = row.toJSON();
      const ft = row.FeatureType;
      // Readiness from the SAME function the publish gate uses, so the list can
      // never promise a pack is publishable that the gate would then reject.
      const missing = quotaPackPublish.missingFromSignals({
        ...p, is_topupable: ft ? Number(ft.is_topupable) === 1 : false,
      });
      return { ...p, is_publishable: missing.length === 0, missing_for_publish: missing };
    }),
  };
}

// adminCrud's beforeWrite hook. The checklist needs `is_topupable`, which lives on
// the feature type rather than the pack, so resolve whichever feature the write
// points at before handing off to the shared gate.
async function assertPackWritable(patch, row) {
  const featureTypeId = patch.feature_type_id ?? row?.feature_type_id;
  const featureType   = featureTypeId ? await featureTypeRepo.findById(featureTypeId) : null;

  if (patch.feature_type_id && !featureType) {
    throw new ValidationError('Validation failed', [
      { field: 'feature_type_id', message: 'Unknown feature type' },
    ]);
  }

  quotaPackPublish.assertPublishable(row, patch, featureType);
}

// Hand quota to a user directly — a failed generation, a goodwill credit, a
// refund settled outside Razorpay. Recorded as a grant like any other so it
// spends, reports and reconciles identically; `source` and `note` are what
// separate it from a purchase in the audit trail.
async function grantToUser(userUid, { feature, quantity, note }) {
  const user = await userRepo.findByUid(userUid);
  if (!user) throw new NotFoundError('User not found');

  const ft = await featureTypeRepo.findByKey(feature);
  if (!ft) throw new NotFoundError('Feature type not found');
  if (Number(ft.is_topupable) !== 1) throw new ValidationError('This feature cannot be topped up');

  const grant = await grantRepo.create({
    uid:             uuid(),
    user_id:         user.id,
    feature_type_id: ft.id,
    quota_pack_id:   null,
    quantity:        Math.trunc(Number(quantity)),
    source:          'admin_grant',
    payment_id:      null,
    // Active immediately — there is no payment to wait for.
    status:          'active',
    note:            note || null,
    granted_at:      new Date(),
  });

  return grant;
}

async function listGrantsForUser(userUid) {
  const user = await userRepo.findByUid(userUid);
  if (!user) throw new NotFoundError('User not found');
  return grantRepo.findForUser(user.id);
}

// Withdraw a grant. The row is KEPT — it is the record that the quota was once
// issued, and support needs to be able to see a mistake as well as undo it.
//
// Revoking drops the grant's quantity and its consumed from the balance together,
// so revoking a fully-spent grant changes nothing rather than clawing back quota
// the user already used. For storage this can leave an account occupying more
// than its ceiling: further uploads are refused, and nothing they already own is
// ever deleted.
async function revokeGrant(uid) {
  const grant = await grantRepo.findByUid(uid);
  if (!grant) throw new NotFoundError('Grant not found');
  if (grant.status === 'revoked') return { ok: true, idempotent: true };
  // A pending grant is an unconfirmed purchase. Revoking it would let a webhook
  // arriving moments later find a row it must not activate — which fulfilPayment
  // guards — but the honest fix for an unwanted purchase is a refund, not this.
  if (grant.status !== 'active') throw new ConflictError('Only an active grant can be revoked');

  await grantRepo.update(grant.id, { status: 'revoked' });
  return { ok: true };
}

module.exports = {
  listStore, getPack, purchasePack, fulfilPayment,
  listForAdmin, assertPackWritable, grantToUser, listGrantsForUser, revokeGrant,
};
