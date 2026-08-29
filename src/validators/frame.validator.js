const Joi = require('joi');

const FRAME_TYPES = ['static', 'animated'];
const STATUSES    = ['draft', 'active', 'inactive'];

// Unlike templates — whose `content` and `thumbnail_s3_key` are written by the
// separate bundle-confirm flow — a frame is a single design, so both are set
// here directly. The publish gate (services/framePublish.js) is what refuses to
// activate a frame that is still missing either.
//
// `price` is PRE-tax, in rupees; GST is added at checkout. `strike_price` is the
// struck-through "was" figure and is display-only — nothing charges against it.
const frameFields = {
  name:             Joi.string().min(1).max(200),
  description:      Joi.string().allow('', null),
  category_id:      Joi.number().integer().allow(null),
  thumbnail_s3_key: Joi.string().max(500).allow('', null),
  content:          Joi.string().allow('', null),
  frame_type:       Joi.string().valid(...FRAME_TYPES),
  is_premium:       Joi.number().valid(0, 1),
  price:            Joi.number().min(0).precision(2),
  strike_price:     Joi.number().min(0).precision(2).allow(null),
  display_order:    Joi.number().integer().min(0),
  status:           Joi.string().valid(...STATUSES),
};

const createFrameSchema = Joi.object({
  ...frameFields,
  name: frameFields.name.required(),
});

const updateFrameSchema = Joi.object({ ...frameFields }).min(1);

// ---- Frame categories (the store's filter chips) ----
const categoryFields = {
  name:          Joi.string().min(1).max(100),
  // Derived from `name` on create when omitted (adminCrud `autoSlug`), and never
  // re-derived on rename — an existing link must not break because someone fixed
  // a typo. Pass one explicitly to change it.
  slug:          Joi.string().max(120),
  display_order: Joi.number().integer().min(0),
  is_active:     Joi.number().valid(0, 1),
};

const createFrameCategorySchema = Joi.object({
  ...categoryFields,
  name: categoryFields.name.required(),
});

const updateFrameCategorySchema = Joi.object({ ...categoryFields }).min(1);

module.exports = {
  createFrameSchema, updateFrameSchema,
  createFrameCategorySchema, updateFrameCategorySchema,
};
