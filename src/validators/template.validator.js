const Joi = require('joi');

const TEMPLATE_TYPES = ['image', 'video', 'animated'];
const STATUSES       = ['draft', 'active', 'inactive'];

// Template metadata only. `content` + `thumbnail_s3_key` are set by the bundle confirm flow,
// not here; counters/trending_score/created_by are system-managed (unknown keys → 400).
const createTemplateSchema = Joi.object({
  name:          Joi.string().min(1).max(200).required(),
  category_id:   Joi.number().integer().allow(null).optional(),
  template_type: Joi.string().valid(...TEMPLATE_TYPES).optional(),
  is_premium:    Joi.number().valid(0, 1).optional(),
  status:        Joi.string().valid(...STATUSES).optional(),
});

const updateTemplateSchema = Joi.object({
  name:          Joi.string().min(1).max(200).optional(),
  category_id:   Joi.number().integer().allow(null).optional(),
  template_type: Joi.string().valid(...TEMPLATE_TYPES).optional(),
  is_premium:    Joi.number().valid(0, 1).optional(),
  status:        Joi.string().valid(...STATUSES).optional(),
}).min(1);

// Unified relation assignment — supply any subset; each provided key is a FULL REPLACE.
const setTemplateRelationsSchema = Joi.object({
  tag_ids:               Joi.array().items(Joi.number().integer()).optional(),
  size_ids:              Joi.array().items(Joi.number().integer()).optional(),
  // `industry_ids` is the public name; `business_category_ids` is the deprecated alias.
  industry_ids:          Joi.array().items(Joi.number().integer()).optional(),
  business_category_ids: Joi.array().items(Joi.number().integer()).optional(),
  theme_ids:             Joi.array().items(Joi.number().integer()).optional(),
}).min(1);

// ---- Template sizes ----
const PLATFORMS = ['instagram', 'facebook', 'youtube', 'whatsapp', 'custom'];

const createTemplateSizeSchema = Joi.object({
  name:      Joi.string().min(1).max(100).required(),
  width:     Joi.number().integer().min(1).required(),
  height:    Joi.number().integer().min(1).required(),
  unit:      Joi.string().max(10).optional(),
  platform:  Joi.string().valid(...PLATFORMS).optional(),
  is_active: Joi.number().valid(0, 1).optional(),
});

const updateTemplateSizeSchema = Joi.object({
  name:      Joi.string().min(1).max(100).optional(),
  width:     Joi.number().integer().min(1).optional(),
  height:    Joi.number().integer().min(1).optional(),
  unit:      Joi.string().max(10).optional(),
  platform:  Joi.string().valid(...PLATFORMS).optional(),
  is_active: Joi.number().valid(0, 1).optional(),
}).min(1);

module.exports = {
  createTemplateSchema, updateTemplateSchema, setTemplateRelationsSchema,
  createTemplateSizeSchema, updateTemplateSizeSchema,
};
