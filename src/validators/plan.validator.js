const Joi = require('joi');

// ---- Plans ----
const createPlanSchema = Joi.object({
  name:          Joi.string().min(1).max(100).required(),
  description:   Joi.string().allow('', null).optional(),
  plan_type:     Joi.string().valid('subscription', 'access_pass').optional(),
  trial_days:    Joi.number().integer().min(0).allow(null).optional(),
  pass_price:    Joi.number().precision(2).min(0).allow(null).optional(),
  pass_days:     Joi.number().integer().min(1).allow(null).optional(),
  is_popular:    Joi.number().valid(0, 1).optional(),
  status:        Joi.string().valid('active', 'inactive').optional(),
  display_order: Joi.number().integer().optional(),
});

const updatePlanSchema = Joi.object({
  name:          Joi.string().min(1).max(100).optional(),
  description:   Joi.string().allow('', null).optional(),
  plan_type:     Joi.string().valid('subscription', 'access_pass').optional(),
  trial_days:    Joi.number().integer().min(0).allow(null).optional(),
  pass_price:    Joi.number().precision(2).min(0).allow(null).optional(),
  pass_days:     Joi.number().integer().min(1).allow(null).optional(),
  is_popular:    Joi.number().valid(0, 1).optional(),
  status:        Joi.string().valid('active', 'inactive').optional(),
  display_order: Joi.number().integer().optional(),
}).min(1);

// ---- Plan billing options (prices) ----
const createBillingOptionSchema = Joi.object({
  plan_id:          Joi.number().integer().required(),
  billing_cycle:    Joi.string().valid('monthly', 'annual').required(),
  price:            Joi.number().precision(2).min(0).required(),
  discounted_price: Joi.number().precision(2).min(0).allow(null).optional(),
  discount_label:   Joi.string().max(100).allow('', null).optional(),
  currency:         Joi.string().length(3).optional(),
  razorpay_plan_id: Joi.string().max(100).allow('', null).optional(),
  is_active:        Joi.number().valid(0, 1).optional(),
});

const updateBillingOptionSchema = Joi.object({
  plan_id:          Joi.number().integer().optional(),
  billing_cycle:    Joi.string().valid('monthly', 'annual').optional(),
  price:            Joi.number().precision(2).min(0).optional(),
  discounted_price: Joi.number().precision(2).min(0).allow(null).optional(),
  discount_label:   Joi.string().max(100).allow('', null).optional(),
  currency:         Joi.string().length(3).optional(),
  razorpay_plan_id: Joi.string().max(100).allow('', null).optional(),
  is_active:        Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Feature types (the feature catalog) ----
// `is_topupable` opens the feature up to top-up packs. Editable here so enabling
// one later is an admin action rather than a deploy — but it only decides whether
// a pack MAY be sold; the meter itself still has to exist in code for the granted
// quota to ever be spent.
const createFeatureTypeSchema = Joi.object({
  key:          Joi.string().min(1).max(100).required(),
  label:        Joi.string().min(1).max(200).required(),
  description:  Joi.string().allow('', null).optional(),
  reset_period: Joi.string().valid('monthly', 'annual', 'never').optional(),
  data_type:    Joi.string().valid('integer', 'boolean').optional(),
  is_topupable: Joi.number().valid(0, 1).optional(),
});

const updateFeatureTypeSchema = Joi.object({
  key:          Joi.string().min(1).max(100).optional(),
  label:        Joi.string().min(1).max(200).optional(),
  description:  Joi.string().allow('', null).optional(),
  reset_period: Joi.string().valid('monthly', 'annual', 'never').optional(),
  data_type:    Joi.string().valid('integer', 'boolean').optional(),
  is_topupable: Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Plan features (per-plan feature values) ----
// value: -1 = unlimited, 0 = none, >0 = count; for boolean features use 0/1.
const createPlanFeatureSchema = Joi.object({
  plan_id:         Joi.number().integer().required(),
  feature_type_id: Joi.number().integer().required(),
  value:           Joi.number().integer().min(-1).required(),
  display_label:   Joi.string().max(200).allow('', null).optional(),
  display_order:   Joi.number().integer().optional(),
  show_on_card:    Joi.number().valid(0, 1).optional(),
});

const updatePlanFeatureSchema = Joi.object({
  plan_id:         Joi.number().integer().optional(),
  feature_type_id: Joi.number().integer().optional(),
  value:           Joi.number().integer().min(-1).optional(),
  display_label:   Joi.string().max(200).allow('', null).optional(),
  display_order:   Joi.number().integer().optional(),
  show_on_card:    Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Coupons ----
// Shape and bounds only. The cross-field invariants (percentage <= 100,
// valid_to > valid_from, max_uses >= used_count) live in services/couponRules.js
// so a PATCH that carries only one half of a pair is judged on the merged state.
// `used_count` is deliberately absent from both schemas: it is system-managed
// (bumped on activation), so an admin sending it gets a 400 rather than silently
// rewriting redemption history.
const couponCode = Joi.string().min(3).max(50).pattern(/^[A-Za-z0-9_-]+$/).messages({
  'string.pattern.base': 'code may only contain letters, numbers, hyphens and underscores',
});

const createCouponSchema = Joi.object({
  code:            couponCode.required(),
  title:           Joi.string().min(1).max(200).required(),
  discount_type:   Joi.string().valid('percentage', 'fixed').required(),
  discount_value:  Joi.number().precision(2).positive().required(),
  applicable_to:   Joi.string().valid('all_plans', 'specific_plans').optional(),
  target_audience: Joi.string().valid('all', 'new_users', 'existing_users').optional(),
  max_uses:        Joi.number().integer().min(1).allow(null).optional(),
  valid_from:      Joi.date().required(),
  valid_to:        Joi.date().allow(null).optional(),
  status:          Joi.string().valid('active', 'inactive', 'expired').optional(),
});

const updateCouponSchema = Joi.object({
  code:            couponCode.optional(),
  title:           Joi.string().min(1).max(200).optional(),
  discount_type:   Joi.string().valid('percentage', 'fixed').optional(),
  discount_value:  Joi.number().precision(2).positive().optional(),
  applicable_to:   Joi.string().valid('all_plans', 'specific_plans').optional(),
  target_audience: Joi.string().valid('all', 'new_users', 'existing_users').optional(),
  max_uses:        Joi.number().integer().min(1).allow(null).optional(),
  valid_from:      Joi.date().optional(),
  valid_to:        Joi.date().allow(null).optional(),
  status:          Joi.string().valid('active', 'inactive', 'expired').optional(),
}).min(1);

// ---- Coupon <-> plan scoping (full replace) ----
// An empty array is meaningful: it clears the scoping and returns the coupon to
// all_plans, so `required()` rather than `min(1)`.
const setCouponPlansSchema = Joi.object({
  plan_ids: Joi.array().items(Joi.number().integer()).required(),
});

module.exports = {
  createPlanSchema, updatePlanSchema,
  createBillingOptionSchema, updateBillingOptionSchema,
  createFeatureTypeSchema, updateFeatureTypeSchema,
  createPlanFeatureSchema, updatePlanFeatureSchema,
  createCouponSchema, updateCouponSchema, setCouponPlansSchema,
};
