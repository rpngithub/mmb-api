const Joi = require('joi');

const TEMPLATE_TYPES = ['image', 'video', 'animated'];
const STATUSES       = ['draft', 'active', 'inactive'];

// ---- Template families (designs) ----
// A family owns everything its versions share. Counters/trending_score/created_by are
// system-managed (unknown keys → 400). A new family is always a draft: it has no
// versions yet, so it cannot meet the publish gate.
const createFamilySchema = Joi.object({
  name:          Joi.string().min(1).max(200).required(),
  category_id:   Joi.number().integer().allow(null).optional(),
  template_type: Joi.string().valid(...TEMPLATE_TYPES).optional(),
  is_premium:    Joi.number().valid(0, 1).optional(),
  is_popular:    Joi.number().valid(0, 1).optional(),
  status:        Joi.string().valid(...STATUSES).optional(),
});

const updateFamilySchema = Joi.object({
  name:          Joi.string().min(1).max(200).optional(),
  category_id:   Joi.number().integer().allow(null).optional(),
  template_type: Joi.string().valid(...TEMPLATE_TYPES).optional(),
  is_premium:    Joi.number().valid(0, 1).optional(),
  is_popular:    Joi.number().valid(0, 1).optional(),
  status:        Joi.string().valid(...STATUSES).optional(),
}).min(1);

// ---- Template versions ----
// One language × size of a family. `content` + `thumbnail_s3_key` are set by the
// bundle confirm flow, not here. A version changes family only through the move
// endpoint (which checks the rules), never by PATCHing family_id.
const createTemplateSchema = Joi.object({
  family_id:   Joi.number().integer().positive().required(),
  // A label for admins; defaults to the family's name.
  name:        Joi.string().min(1).max(200).optional(),
  // The language the design's text is in. NULL = text-free (no text, or symbols
  // only), shown to every user whatever they picked in Preferred Languages. A
  // family is all text-free or all languages, never a mix.
  language_id: Joi.number().integer().positive().allow(null).required(),
  size_id:     Joi.number().integer().positive().required(),
  status:      Joi.string().valid(...STATUSES).optional(),
});

const updateTemplateSchema = Joi.object({
  name:        Joi.string().min(1).max(200).optional(),
  language_id: Joi.number().integer().positive().allow(null).optional(),
  size_id:     Joi.number().integer().positive().optional(),
  status:      Joi.string().valid(...STATUSES).optional(),
}).min(1);

// Relation assignment on a family — supply any subset; each provided key is a FULL
// REPLACE. `size_ids` is rejected with a pointer to per-version sizes.
const setTemplateRelationsSchema = Joi.object({
  tag_ids:               Joi.array().items(Joi.number().integer()).optional(),
  size_ids:              Joi.any().optional(),
  // `industry_ids` is the public name; `business_category_ids` is the deprecated alias.
  industry_ids:          Joi.array().items(Joi.number().integer()).optional(),
  business_category_ids: Joi.array().items(Joi.number().integer()).optional(),
  // `variant_ids` is the current name; `theme_ids` is the deprecated alias.
  variant_ids:           Joi.array().items(Joi.number().integer()).optional(),
  theme_ids:             Joi.array().items(Joi.number().integer()).optional(),
}).min(1);

const moveTemplateSchema = Joi.object({
  family_uid: Joi.string().guid().required(),
});

const mergeFamilySchema = Joi.object({
  into_family_uid: Joi.string().guid().required(),
});

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
  createFamilySchema, updateFamilySchema, moveTemplateSchema, mergeFamilySchema,
  createTemplateSchema, updateTemplateSchema, setTemplateRelationsSchema,
  createTemplateSizeSchema, updateTemplateSizeSchema,
};
