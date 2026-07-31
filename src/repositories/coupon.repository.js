const BaseRepository = require('./base.repository');
const { Coupon, CouponPlanRestriction } = require('../models');
const { Op, literal } = require('sequelize');

class CouponRepository extends BaseRepository {
  constructor() { super(Coupon); }

  // A 'specific_plans' coupon is redeemable only against the plans listed in
  // coupon_plan_restrictions. 'all_plans' coupons have no rows and never reach here.
  async appliesToPlan(couponId, planId) {
    const n = await CouponPlanRestriction.count({ where: { coupon_id: couponId, plan_id: planId } });
    return n > 0;
  }

  // Atomic guarded increment, called once when a coupon-bearing subscription
  // activates. The `max_uses IS NULL OR used_count < max_uses` predicate lives in
  // the UPDATE (not a read-then-write) so concurrent redemptions cannot overshoot
  // the cap; returns false when the coupon was already exhausted.
  async incrementUsage(couponId) {
    const [affected] = await this.model.update(
      { used_count: literal('used_count + 1') },
      { where: { id: couponId, [Op.and]: literal('(max_uses IS NULL OR used_count < max_uses)') } }
    );
    return affected > 0;
  }

  findActiveByCode(code) {
    return this.findOne({
      code,
      status: 'active',
      valid_from: { [Op.lte]: new Date() },
      [Op.or]: [{ valid_to: null }, { valid_to: { [Op.gte]: new Date() } }],
    });
  }

  // applicable_to='all_plans' coupons apply to every plan and have no
  // coupon_plan_restrictions rows, so they must be merged in separately on the
  // public /plans grid. Public-safe attributes only.
  findActivePublicGlobal() {
    const now = new Date();
    return this.model.findAll({
      where: {
        status:          'active',
        applicable_to:   'all_plans',
        valid_from:      { [Op.lte]: now },
        [Op.or]:         [{ valid_to: null }, { valid_to: { [Op.gte]: now } }],
        target_audience: { [Op.in]: ['all', 'new_users'] },
      },
      attributes: ['uid', 'code', 'title', 'discount_type', 'discount_value', 'valid_to'],
      raw: true,
    });
  }
}

module.exports = new CouponRepository();
