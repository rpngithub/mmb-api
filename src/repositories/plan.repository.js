const BaseRepository = require('./base.repository');
const { Op } = require('sequelize');
const { Plan, PlanBillingOption, PlanFeature, FeatureType, Coupon } = require('../models');

// Coupons surfaced on the public /plans grid: active, inside their validity
// window, and not internally targeted. Mirrors coupon.repository's public scope.
const PUBLIC_COUPON_ATTRS = ['uid', 'code', 'title', 'discount_type', 'discount_value', 'valid_to'];
function publicCouponWhere() {
  const now = new Date();
  return {
    status:          'active',
    valid_from:      { [Op.lte]: now },
    [Op.or]:         [{ valid_to: null }, { valid_to: { [Op.gte]: now } }],
    target_audience: { [Op.in]: ['all', 'new_users'] },
  };
}

class PlanRepository extends BaseRepository {
  constructor() { super(Plan); }

  // Public pricing list. Defaults to subscription plans (the ₹10 access pass is
  // only returned with plan_type='access_pass'). billing_option_type, when set,
  // restricts both the embedded billing options and which plans qualify.
  findAllActive({ plan_type = 'subscription', billing_option_type } = {}) {
    const billingWhere = { is_active: 1 };
    if (billing_option_type) billingWhere.billing_cycle = billing_option_type;

    return this.model.findAll({
      where: { status: 'active', plan_type },
      include: [
        { model: PlanBillingOption, where: billingWhere, required: !!billing_option_type },
        { model: PlanFeature, where: { show_on_card: 1 }, required: false, include: [{ model: FeatureType }] },
        {
          model: Coupon, as: 'coupons', required: false, through: { attributes: [] },
          attributes: PUBLIC_COUPON_ATTRS,
          where: { ...publicCouponWhere(), applicable_to: 'specific_plans' },
        },
      ],
      order: [['display_order', 'ASC']],
    });
  }

  findAccessPass() {
    return this.model.findOne({
      where: { status: 'active', plan_type: 'access_pass' },
      order: [['display_order', 'ASC']],
    });
  }
}

module.exports = new PlanRepository();
