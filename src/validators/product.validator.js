const Joi = require('joi');

const createProductSchema = Joi.object({
  business_uid: Joi.string().uuid().required(),
  name:         Joi.string().min(1).max(200).required(),
  description:  Joi.string().allow('').optional(),
  price:        Joi.number().precision(2).positive().optional(),
});

const updateProductSchema = Joi.object({
  name:        Joi.string().min(1).max(200).optional(),
  description: Joi.string().allow('').optional(),
  price:       Joi.number().precision(2).positive().optional(),
  is_active:   Joi.number().valid(0, 1).optional(),
});

const addImageSchema = Joi.object({
  s3_key:        Joi.string().max(500).required(),
  display_order: Joi.number().integer().min(0).optional(),
});

module.exports = { createProductSchema, updateProductSchema, addImageSchema };
