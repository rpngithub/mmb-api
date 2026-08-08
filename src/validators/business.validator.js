const Joi = require('joi');

// A day is either closed (null) or an { open, close } pair in "HH:MM" form.
const dayHoursSchema = Joi.object({
  open:  Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
  close: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
}).allow(null);

// "My Keywords" — the tags describing the owner's products & services. Always
// picked from the existing tag list (a numeric id, a slug, or the display name);
// there is no custom-keyword path, so an unknown one is rejected server-side.
const keywords = Joi.array().items(Joi.alternatives(Joi.string().max(100), Joi.number().integer().positive())).unique();

// The brand palette: an ordered list, position carries the meaning (first =
// primary). Six is the cap — enough for primary/secondary/accent plus background
// and two extras, small enough to still render as swatches and bind to a template.
// Only full 6-digit hex is accepted: 3-digit shorthand would give two spellings
// of one colour and nothing downstream expands it. Duplicates are rejected
// case-insensitively, since the same colour twice is a client bug, not a palette.
const MAX_BRAND_COLORS = 6;
const brandColors = Joi.array()
  .max(MAX_BRAND_COLORS)
  .items(Joi.object({
    hex:   Joi.string().pattern(/^#[0-9a-fA-F]{6}$/).required()
             .messages({ 'string.pattern.base': 'hex must be a 6-digit colour like #1A2B3C' }),
    label: Joi.string().max(50).allow(null, '').optional(),
  }))
  .unique((a, b) => a.hex.toLowerCase() === b.hex.toLowerCase());

const createBusinessSchema = Joi.object({
  name:        Joi.string().min(2).max(200).required(),
  // `industry` is the public name for the business category — a friendly ref
  // (slug / uid / numeric id) resolved to category_id server-side. `category_id`
  // is the deprecated legacy form (still accepted).
  industry:    Joi.string().optional(),
  // The child pick under `industry`. Mutually exclusive with the "Others" path
  // below; the service also checks it really is a child of `industry`.
  sub_industry: Joi.string().optional(),
  // "Others": free text typed when the owner can't find their sub-industry. Files
  // a pending industry for admin approval and links the business to it.
  custom_sub_industry: Joi.string().min(2).max(100).optional(),
  category_id: Joi.number().integer().optional(),
  keywords:    keywords.optional(),
  description: Joi.string().optional(),
  // Keys from POST /uploads/presign (slots business_logo / business_cover). The
  // service checks each was issued to the caller for that slot; null clears it.
  logo_s3_key:  Joi.string().max(500).allow(null, '').optional(),
  cover_s3_key: Joi.string().max(500).allow(null, '').optional(),
  brand_colors: brandColors.allow(null).optional(),
  // Stamp the owner's own logo/name on exported designs. Turning it ON requires
  // the `custom_watermark` plan feature (403 otherwise); turning it off is always
  // allowed, so a lapsed plan never traps the setting on.
  watermark_enabled: Joi.number().valid(0, 1).optional(),
  // Brand Kit typography — ids from GET /fonts. Must be a library font or one you
  // uploaded; a premium library font needs a paid plan. null clears the role.
  heading_font_id: Joi.number().integer().positive().allow(null).optional(),
  body_font_id:    Joi.number().integer().positive().allow(null).optional(),
  city:        Joi.string().max(100).optional(),
  state:       Joi.string().max(100).optional(),
  address:     Joi.string().optional(),
  latitude:    Joi.number().min(-90).max(90).optional(),
  longitude:   Joi.number().min(-180).max(180).optional(),
  phone:       Joi.string().max(20).optional(),
  whatsapp:    Joi.string().max(20).optional(),
  email:       Joi.string().email().max(150).optional(),
  website:     Joi.string().uri().max(255).optional(),
  social_links: Joi.object().pattern(Joi.string(), Joi.string().uri().allow('')).optional(),
  operating_hours: Joi.object({
    mon: dayHoursSchema, tue: dayHoursSchema, wed: dayHoursSchema, thu: dayHoursSchema,
    fri: dayHoursSchema, sat: dayHoursSchema, sun: dayHoursSchema,
  }).optional(),
}).nand('sub_industry', 'custom_sub_industry');

const updateBusinessSchema = createBusinessSchema.fork(Object.keys(createBusinessSchema.describe().keys), (s) => s.optional());

// Full replace of the keyword set — the "MANAGE" action on the My Keywords card.
// An empty array is a legitimate "clear them all".
const setKeywordsSchema = Joi.object({
  keywords: keywords.required(),
});

// Full replace of the palette; `[]` clears it.
const setBrandColorsSchema = Joi.object({
  brand_colors: brandColors.required(),
});

// "Use This Brand Series": adopt a variant (identified by its public uid) into a
// business. `variant_uid` is the current name; `theme_uid` is the deprecated alias.
const adoptVariantSchema = Joi.object({
  variant_uid: Joi.string().guid().optional(),
  theme_uid:   Joi.string().guid().optional(),
}).or('variant_uid', 'theme_uid');

module.exports = {
  createBusinessSchema, updateBusinessSchema, setKeywordsSchema, setBrandColorsSchema,
  adoptVariantSchema, MAX_BRAND_COLORS,
};
