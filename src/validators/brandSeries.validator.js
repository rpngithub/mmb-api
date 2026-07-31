const Joi = require('joi');

const s3Key = Joi.string().max(500).allow(null, '');
const hex   = Joi.string().pattern(/^#[0-9a-fA-F]{6}$/).message('hex_code must be a #RRGGBB colour code');

// ---- Brand series ----
const createBrandSeriesSchema = Joi.object({
  name:          Joi.string().min(1).max(100).required(),
  icon_s3_key:   s3Key.optional(),
  caption:       Joi.string().max(255).allow(null, '').optional(),   // sub-title
  description:   Joi.string().allow(null, '').optional(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
});

const updateBrandSeriesSchema = Joi.object({
  name:          Joi.string().min(1).max(100).optional(),
  icon_s3_key:   s3Key.optional(),
  caption:       Joi.string().max(255).allow(null, '').optional(),
  description:   Joi.string().allow(null, '').optional(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Variants ----
const createVariantSchema = Joi.object({
  // `series_id` is the current name; `group_id` the deprecated alias.
  series_id:        Joi.number().integer().optional(),
  group_id:         Joi.number().integer().optional(),
  badge_id:         Joi.number().integer().allow(null).optional(),
  name:             Joi.string().min(1).max(100).required(),
  description:      Joi.string().allow(null, '').optional(),
  thumbnail_s3_key: s3Key.optional(),
  likes_count:      Joi.number().integer().min(0).optional(),  // display-only figure on the card
  display_order:    Joi.number().integer().optional(),
  is_active:        Joi.number().valid(0, 1).optional(),
}).or('series_id', 'group_id');

const updateVariantSchema = Joi.object({
  series_id:        Joi.number().integer().optional(),
  group_id:         Joi.number().integer().optional(),
  badge_id:         Joi.number().integer().allow(null).optional(),
  name:             Joi.string().min(1).max(100).optional(),
  description:      Joi.string().allow(null, '').optional(),
  thumbnail_s3_key: s3Key.optional(),
  likes_count:      Joi.number().integer().min(0).optional(),
  display_order:    Joi.number().integer().optional(),
  is_active:        Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Style personalities ("Bold", "Premium", "Confident") ----
const createStylePersonalitySchema = Joi.object({
  name:          Joi.string().min(1).max(100).required(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
});

const updateStylePersonalitySchema = Joi.object({
  name:          Joi.string().min(1).max(100).optional(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Colours (shared palette: name + code, so the frontend can render either) ----
const createColorSchema = Joi.object({
  name:          Joi.string().min(1).max(100).required(),
  hex_code:      hex.required(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
});

const updateColorSchema = Joi.object({
  name:          Joi.string().min(1).max(100).optional(),
  hex_code:      hex.optional(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Variant badges ("Popular", "Fresh", "Dynamic") ----
const createVariantBadgeSchema = Joi.object({
  name:          Joi.string().min(1).max(100).required(),
  icon_s3_key:   s3Key.optional(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
});

const updateVariantBadgeSchema = Joi.object({
  name:          Joi.string().min(1).max(100).optional(),
  icon_s3_key:   s3Key.optional(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
}).min(1);

// ---- Variant <-> template assignment (full replace) ----
const setVariantTemplatesSchema = Joi.object({
  template_ids: Joi.array().items(Joi.number().integer()).required(),
});

// ---- Variant relations (plan entitlements + industries; each key a full replace) ----
const setVariantRelationsSchema = Joi.object({
  plan_ids:              Joi.array().items(Joi.number().integer()).optional(),
  // `industry_ids` is the public name; `business_category_ids` is the deprecated alias.
  industry_ids:          Joi.array().items(Joi.number().integer()).optional(),
  business_category_ids: Joi.array().items(Joi.number().integer()).optional(),
}).min(1);

// ---- Brand series relations (descriptive only; each key a full replace) ----
// Order is taken from the array order for the two ordered collections, so the admin
// can drag to reorder without a separate endpoint.
const setBrandSeriesRelationsSchema = Joi.object({
  style_personality_ids: Joi.array().items(Joi.number().integer()).optional(),
  tag_ids:               Joi.array().items(Joi.number().integer()).optional(),
  color_ids:             Joi.array().items(Joi.number().integer()).optional(),
}).min(1);

module.exports = {
  createBrandSeriesSchema, updateBrandSeriesSchema,
  createVariantSchema, updateVariantSchema,
  createStylePersonalitySchema, updateStylePersonalitySchema,
  createColorSchema, updateColorSchema,
  createVariantBadgeSchema, updateVariantBadgeSchema,
  setVariantTemplatesSchema, setVariantRelationsSchema, setBrandSeriesRelationsSchema,
};
