const Joi = require('joi');

const s3Key = Joi.string().max(500).allow(null, '');

// ---- Template categories ----
const createTemplateCategorySchema = Joi.object({
  parent_id:        Joi.number().integer().allow(null).optional(),
  name:             Joi.string().min(1).max(100).required(),
  icon_s3_key:      s3Key.optional(),
  thumbnail_s3_key: s3Key.optional(),
  show_in_homepage: Joi.number().valid(0, 1).optional(),
  display_order:    Joi.number().integer().optional(),
  is_active:        Joi.number().valid(0, 1).optional(),
});

const updateTemplateCategorySchema = Joi.object({
  parent_id:        Joi.number().integer().allow(null).optional(),
  name:             Joi.string().min(1).max(100).optional(),
  icon_s3_key:      s3Key.optional(),
  thumbnail_s3_key: s3Key.optional(),
  show_in_homepage: Joi.number().valid(0, 1).optional(),
  display_order:    Joi.number().integer().optional(),
  is_active:        Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Business categories (no show_in_homepage; tags managed via dedicated endpoint) ----
const createBusinessCategorySchema = Joi.object({
  parent_id:        Joi.number().integer().allow(null).optional(),
  name:             Joi.string().min(1).max(100).required(),
  icon_s3_key:      s3Key.optional(),
  thumbnail_s3_key: s3Key.optional(),
  display_order:    Joi.number().integer().optional(),
  is_active:        Joi.number().valid(0, 1).optional(),
});

const updateBusinessCategorySchema = Joi.object({
  parent_id:        Joi.number().integer().allow(null).optional(),
  name:             Joi.string().min(1).max(100).optional(),
  icon_s3_key:      s3Key.optional(),
  thumbnail_s3_key: s3Key.optional(),
  display_order:    Joi.number().integer().optional(),
  is_active:        Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Tags ----
const createTagSchema = Joi.object({
  name: Joi.string().min(1).max(100).required(),
});

const updateTagSchema = Joi.object({
  name: Joi.string().min(1).max(100).required(),
});

// ---- Business-category tag assignment (full replace) ----
const setTagsSchema = Joi.object({
  tag_ids: Joi.array().items(Joi.number().integer()).required(),
});

module.exports = {
  createTemplateCategorySchema, updateTemplateCategorySchema,
  createBusinessCategorySchema, updateBusinessCategorySchema,
  createTagSchema, updateTagSchema,
  setTagsSchema,
};
