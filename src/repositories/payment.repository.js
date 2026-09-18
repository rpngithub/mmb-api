const BaseRepository = require('./base.repository');
const {
  Payment, UserSubscription, Plan, PlanBillingOption, Coupon, UserQuotaGrant, QuotaPack, UserFrame, Frame,
} = require('../models');

// Everything a history row or an invoice needs to say WHAT was bought, in one
// query. A payment's purchasable is reached through whichever side-table holds
// its payment_id: the subscription (plan + cycle), the quota grant (pack) or
// the frame ownership row. `required: false` throughout — a row is never
// dropped because its purchasable was since deleted.
const DESCRIBE = [
  { model: UserSubscription, required: false, include: [
    { model: Plan, attributes: ['uid', 'name', 'plan_type'] },
    { model: PlanBillingOption, attributes: ['billing_cycle'] },
    { model: Coupon, attributes: ['code', 'title'] },
  ] },
  { model: UserQuotaGrant, required: false, attributes: ['quantity'], include: [{ model: QuotaPack, attributes: ['name'] }] },
  { model: UserFrame, required: false, attributes: ['id'], include: [{ model: Frame, attributes: ['name'] }] },
];

class PaymentRepository extends BaseRepository {
  constructor() { super(Payment); }

  findByRazorpayOrderId(orderId)     { return this.findOne({ razorpay_order_id: orderId }); }
  findByRazorpayPaymentId(paymentId) { return this.findOne({ razorpay_payment_id: paymentId }); }

  // The Billing screen's history: every payment the user ever started, newest
  // first. Pending and failed rows are included on purpose — the screen shows
  // them (with a Retry), and hiding a failed charge is how "why was I billed
  // twice?" tickets start.
  findHistory(userId, { limit, offset }) {
    return this.findAndCountAll({ user_id: userId }, {
      include: DESCRIBE, order: [['created_at', 'DESC'], ['id', 'DESC']], limit, offset, distinct: true,
    });
  }

  findDescribedByUid(uid) {
    return this.findByUid(uid, { include: DESCRIBE });
  }

  // The most recent successful charge on one subscription — where the
  // subscription's "payment method" comes from.
  findLatestSuccessForSubscription(subscriptionId) {
    return this.findOne({ subscription_id: subscriptionId, status: 'success' }, {
      order: [['paid_at', 'DESC'], ['id', 'DESC']],
    });
  }
}

module.exports = new PaymentRepository();
