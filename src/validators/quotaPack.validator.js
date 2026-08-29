const Joi = require('joi');

const STATUSES = ['draft', 'active', 'inactive'];

// Joi does shape, types, enums and bounds; the cross-field invariants live in
// services/quotaPackPublish.js, because a PATCH may carry only one half of a pair
// (a status without a quantity) and Joi would have nothing to compare against.
//
// `quantity` is in the FEATURE's own unit — credits, or megabytes for storage —
// matching plan_features.value, so a pack and a plan allowance are directly
// comparable. `price` is PRE-tax in rupees; GST is added at checkout.
// `strike_price` is the struck-through "was" figure and is display-only.
const packFields = {
  feature_type_id: Joi.number().integer().positive(),
  name:            Joi.string().min(1).max(150),
  description:     Joi.string().allow('', null),
  quantity:        Joi.number().integer().min(0),
  price:           Joi.number().min(0).precision(2),
  strike_price:    Joi.number().min(0).precision(2).allow(null),
  badge:           Joi.string().max(40).allow('', null),
  display_order:   Joi.number().integer().min(0),
  status:          Joi.string().valid(...STATUSES),
};

const createQuotaPackSchema = Joi.object({
  ...packFields,
  name:            packFields.name.required(),
  feature_type_id: packFields.feature_type_id.required(),
});

const updateQuotaPackSchema = Joi.object({ ...packFields }).min(1);

// Admin hand-grant. `feature` is the feature_types key rather than an id: this is
// typed by a human in a support tool, and 'ai_credits' is checkable by eye in a
// way that a numeric id is not.
//
// `note` is REQUIRED. A grant with no reason is indistinguishable from a mistake
// six months later, and this is the one path that mints quota without a payment
// behind it.
const adminGrantSchema = Joi.object({
  feature:  Joi.string().max(100).required(),
  quantity: Joi.number().integer().positive().required(),
  note:     Joi.string().min(1).max(255).required(),
});

module.exports = { createQuotaPackSchema, updateQuotaPackSchema, adminGrantSchema };
