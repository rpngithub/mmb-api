const { ValidationError } = require('../errors');
const { CouponPlanRestriction } = require('../models');

// Cross-field invariants for a coupon row. These can't live in the Joi schema
// because a PATCH may carry only one half of a pair (e.g. `discount_value`
// without `discount_type`), and Joi would then have nothing to compare against.
// Everything here is judged on the state the row WOULD have after the write.
//
// Enforced:
//   - a percentage coupon can't exceed 100%
//   - valid_to must be after valid_from
//   - max_uses can't be set below the redemptions already counted (used_count),
//     which would strand the coupon in a permanently-exhausted state
//
// Redemption-time rules (is this coupon usable *right now, by this user, for this
// plan*) are a different concern and live in subscription.service.assertRedeemable.
async function assertCouponConsistent(patch, row) {
  const next    = { ...(row ? row.toJSON() : {}), ...patch };
  const details = [];
  const bad     = (field, message) => details.push({ field, message });

  // `specific_plans` with no linked plans matches nothing, so the coupon would be
  // rejected for every plan — a silently dead coupon. The plan list is owned by
  // PUT /admin/coupons/:uid/plans (which flips this field for you), so the only
  // way to reach this state is setting the flag by hand. On create there are
  // never rows yet, hence the pointer to the other endpoint.
  if (next.applicable_to === 'specific_plans') {
    const linked = row ? await CouponPlanRestriction.count({ where: { coupon_id: row.id } }) : 0;
    if (!linked) {
      bad('applicable_to', 'A specific_plans coupon needs at least one plan — set them via PUT /admin/coupons/:uid/plans');
    }
  }

  const value = next.discount_value === null || next.discount_value === undefined
    ? null
    : parseFloat(next.discount_value);

  if (next.discount_type === 'percentage' && value !== null && value > 100) {
    bad('discount_value', 'A percentage discount cannot exceed 100');
  }

  if (next.valid_from && next.valid_to) {
    if (new Date(next.valid_to) <= new Date(next.valid_from)) {
      bad('valid_to', 'valid_to must be after valid_from');
    }
  }

  const used = Number(next.used_count || 0);
  if (next.max_uses !== null && next.max_uses !== undefined && Number(next.max_uses) < used) {
    bad('max_uses', `max_uses cannot be below the ${used} redemption(s) already used`);
  }

  if (details.length) throw new ValidationError('Coupon is not valid', details);
}

module.exports = { assertCouponConsistent };
