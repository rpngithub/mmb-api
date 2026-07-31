const Joi = require('joi');

const s3Key  = Joi.string().max(500).allow(null, '');
const status = Joi.string().valid('active', 'inactive');

const createTestimonialSchema = Joi.object({
  name:                 Joi.string().min(1).max(100).required(),
  designation:          Joi.string().max(200).allow(null, '').optional(),
  business_category_id: Joi.number().integer().allow(null).optional(),
  content:              Joi.string().min(1).required(),
  rating:               Joi.number().integer().min(1).max(5).allow(null).optional(),
  photo_s3_key:         s3Key.optional(),
  display_order:        Joi.number().integer().optional(),
  status:               status.optional(),
});

const updateTestimonialSchema = Joi.object({
  name:                 Joi.string().min(1).max(100),
  designation:          Joi.string().max(200).allow(null, ''),
  business_category_id: Joi.number().integer().allow(null),
  content:              Joi.string().min(1),
  rating:               Joi.number().integer().min(1).max(5).allow(null),
  photo_s3_key:         s3Key,
  display_order:        Joi.number().integer(),
  status:               status,
}).min(1);

module.exports = { createTestimonialSchema, updateTestimonialSchema };
