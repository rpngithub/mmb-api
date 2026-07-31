const Joi = require('joi');

const upsertBillingSchema = Joi.object({
  billing_name:    Joi.string().min(1).max(200).required(),
  gstin:           Joi.string().length(15).allow(null, '').optional(),
  billing_address: Joi.string().min(1).required(),
  billing_state:   Joi.string().min(1).max(100).required(),
  billing_pincode: Joi.string().min(1).max(10).required(),
});

module.exports = { upsertBillingSchema };
