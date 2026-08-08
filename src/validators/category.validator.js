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

// `status` is the moderation verdict on a user-suggested sub-industry; setting it
// to approved/rejected also flips is_active (see syncIndustryVisibility in the
// admin router), so an admin normally sends status alone.
const updateBusinessCategorySchema = Joi.object({
  parent_id:        Joi.number().integer().allow(null).optional(),
  name:             Joi.string().min(1).max(100).optional(),
  icon_s3_key:      s3Key.optional(),
  thumbnail_s3_key: s3Key.optional(),
  display_order:    Joi.number().integer().optional(),
  status:           Joi.string().valid('approved', 'pending', 'rejected').optional(),
  is_active:        Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Languages (content languages for templates) ----
const createLanguageSchema = Joi.object({
  code:          Joi.string().lowercase().max(10).pattern(/^[a-z]{2}(-[a-z]{2})?$/).required(),
  name:          Joi.string().min(1).max(50).required(),   // "Tamil" — English label
  native_name:   Joi.string().min(1).max(50).required(),   // "தமிழ்" — what the picker shows
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
});

const updateLanguageSchema = createLanguageSchema.fork(
  ['code', 'name', 'native_name'], (s) => s.optional(),
).min(1);

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

// ---- Related industries, the SEO cross-link block (full replace, ordered) ----
// Array ORDER is the editor's drag order and becomes display_order, so ids must be
// unique. `related_category_ids` is the deprecated alias, mirroring the
// industry_ids / business_category_ids pairing used on variant + template relations.
const relatedIds = Joi.array().items(Joi.number().integer().positive()).unique();
const setRelatedIndustriesSchema = Joi.object({
  related_industry_ids: relatedIds,
  related_category_ids: relatedIds,
}).or('related_industry_ids', 'related_category_ids');

module.exports = {
  createTemplateCategorySchema, updateTemplateCategorySchema,
  createBusinessCategorySchema, updateBusinessCategorySchema,
  createTagSchema, updateTagSchema,
  createLanguageSchema, updateLanguageSchema,
  setTagsSchema, setRelatedIndustriesSchema,
};
