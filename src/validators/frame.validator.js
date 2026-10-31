const Joi = require('joi');

const FRAME_TYPES = ['static', 'animated'];
const STATUSES    = ['draft', 'active', 'inactive'];

// A frame is the FAMILY: what its versions share. The designs themselves —
// `content` and `thumbnail_s3_key` — are per version (frame versions, below), one
// per language × size; sending them here is a 400, not silently dropped, so an
// admin client still on the old shape finds out at once.
//
// `price` is PRE-tax, in rupees; GST is added at checkout. `strike_price` is the
// struck-through "was" figure and is display-only — nothing charges against it.
const frameFields = {
  name:             Joi.string().min(1).max(200),
  description:      Joi.string().allow('', null),
  category_id:      Joi.number().integer().allow(null),
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

// ---- Frame versions (one language × size of a frame) ----
// The design normally arrives through the bundle flow (POST
// /admin/frame-versions/{uid}/bundle/confirm); `content` / `thumbnail_s3_key` stay
// writable here for a self-contained design or a slot thumbnail. `frame_id` is
// fixed at create — moving a version is POST /admin/frame-versions/{uid}/move.
const versionFields = {
  // NULL = text-free, shown to everyone. A frame is all text-free or all
  // languages, never a mix.
  language_id:      Joi.number().integer().positive().allow(null),
  size_id:          Joi.number().integer().positive(),
  thumbnail_s3_key: Joi.string().max(500).allow('', null),
  content:          Joi.string().allow('', null),
  status:           Joi.string().valid(...STATUSES),
};

const createFrameVersionSchema = Joi.object({
  ...versionFields,
  frame_id:    Joi.number().integer().positive().required(),
  language_id: versionFields.language_id.required(),
  size_id:     versionFields.size_id.required(),
});

const updateFrameVersionSchema = Joi.object({ ...versionFields }).min(1);

const moveFrameVersionSchema = Joi.object({
  frame_uid: Joi.string().guid().required(),
});

const mergeFrameSchema = Joi.object({
  into_frame_uid: Joi.string().guid().required(),
});

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
  createFrameVersionSchema, updateFrameVersionSchema, moveFrameVersionSchema, mergeFrameSchema,
  createFrameCategorySchema, updateFrameCategorySchema,
};
