const Joi = require('joi');

const status = Joi.string().valid('active', 'inactive');

// ---- FAQ categories ----
// Name uniqueness (case-insensitive) is enforced by adminCrud's `unique` option
// plus a DB unique index; here we only shape/required-check the payload.
const createFaqCategorySchema = Joi.object({
  name:          Joi.string().min(1).max(100).required(),
  display_order: Joi.number().integer().optional(),
  status:        status.optional(),
});

const updateFaqCategorySchema = Joi.object({
  name:          Joi.string().min(1).max(100),
  display_order: Joi.number().integer(),
  status:        status,
}).min(1);

// ---- FAQs ----
const createFaqSchema = Joi.object({
  category_id:   Joi.number().integer().allow(null).optional(),
  question:      Joi.string().min(1).required(),
  answer:        Joi.string().min(1).required(),
  display_order: Joi.number().integer().optional(),
  status:        status.optional(),
});

const updateFaqSchema = Joi.object({
  category_id:   Joi.number().integer().allow(null),
  question:      Joi.string().min(1),
  answer:        Joi.string().min(1),
  display_order: Joi.number().integer(),
  status:        status,
}).min(1);

module.exports = {
  createFaqCategorySchema, updateFaqCategorySchema,
  createFaqSchema, updateFaqSchema,
};
