const Joi = require('joi');

const TYPES = ['product', 'service'];

// `unit` belongs to a product, `service_area` to a service. The pairing against
// the stored type (and offer_price against the stored price) is enforced in the
// service, since a PATCH may carry one side without the other.
const price = Joi.number().precision(2).positive();

const createProductSchema = Joi.object({
  business_uid: Joi.string().uuid().required(),
  type:         Joi.string().valid(...TYPES).default('product'),
  name:         Joi.string().min(1).max(200).required(),
  unit:         Joi.string().trim().max(50).allow('', null).optional(),
  service_area: Joi.string().trim().max(200).allow('', null).optional(),
  description:  Joi.string().allow('').optional(),
  price:        price.optional(),
  offer_price:  price.allow(null).optional(),
});

const updateProductSchema = Joi.object({
  type:         Joi.string().valid(...TYPES).optional(),
  name:         Joi.string().min(1).max(200).optional(),
  unit:         Joi.string().trim().max(50).allow('', null).optional(),
  service_area: Joi.string().trim().max(200).allow('', null).optional(),
  description:  Joi.string().allow('').optional(),
  price:        price.allow(null).optional(),
  offer_price:  price.allow(null).optional(),
  is_active:    Joi.number().valid(0, 1).optional(),
});

const addImageSchema = Joi.object({
  s3_key:        Joi.string().max(500).required(),
  display_order: Joi.number().integer().min(0).optional(),
});

module.exports = { createProductSchema, updateProductSchema, addImageSchema };
