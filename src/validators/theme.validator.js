const Joi = require('joi');

const s3Key = Joi.string().max(500).allow(null, '');

// ---- Theme groups ----
const createThemeGroupSchema = Joi.object({
  name:          Joi.string().min(1).max(100).required(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
});

const updateThemeGroupSchema = Joi.object({
  name:          Joi.string().min(1).max(100).optional(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Themes ----
const createThemeSchema = Joi.object({
  group_id:         Joi.number().integer().required(),
  name:             Joi.string().min(1).max(100).required(),
  description:      Joi.string().allow(null, '').optional(),
  thumbnail_s3_key: s3Key.optional(),
  likes_count:      Joi.number().integer().min(0).optional(),  // display-only figure on the card
  display_order:    Joi.number().integer().optional(),
  is_active:        Joi.number().valid(0, 1).optional(),
});

const updateThemeSchema = Joi.object({
  group_id:         Joi.number().integer().optional(),
  name:             Joi.string().min(1).max(100).optional(),
  description:      Joi.string().allow(null, '').optional(),
  thumbnail_s3_key: s3Key.optional(),
  likes_count:      Joi.number().integer().min(0).optional(),
  display_order:    Joi.number().integer().optional(),
  is_active:        Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Theme <-> template assignment (full replace) ----
const setThemeTemplatesSchema = Joi.object({
  template_ids: Joi.array().items(Joi.number().integer()).required(),
});

// ---- Theme relations (plan entitlements + business categories; each key a full replace) ----
const setThemeRelationsSchema = Joi.object({
  plan_ids:              Joi.array().items(Joi.number().integer()).optional(),
  // `industry_ids` is the public name; `business_category_ids` is the deprecated alias.
  industry_ids:          Joi.array().items(Joi.number().integer()).optional(),
  business_category_ids: Joi.array().items(Joi.number().integer()).optional(),
}).min(1);

module.exports = {
  createThemeGroupSchema, updateThemeGroupSchema,
  createThemeSchema, updateThemeSchema,
  setThemeTemplatesSchema, setThemeRelationsSchema,
};
