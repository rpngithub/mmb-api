const Joi = require('joi');

// `section_key` is the website's rendering contract, so it is constrained to the
// shape a component name can be keyed on — lowercase, underscore-separated. It is
// NOT an enum: adding a block to the site must not require an API release.
//
// REJECTS rather than lowercases. middlewares/validate.js checks the schema but
// throws away Joi's coerced value, so a `.lowercase()` here would let "Why_Choose"
// pass and then store it verbatim — a key the website silently fails to match. A
// 400 naming the rule is the honest answer.
const key = Joi.string().pattern(/^[a-z0-9_]+$/).max(50)
  .messages({ 'string.pattern.base': 'must be lowercase letters, digits and underscores (e.g. why_choose)' });

// ---- Page sections ----
const createPageSectionSchema = Joi.object({
  page_key:             key.default('industry'),
  // null (or omitted) authors the DEFAULT that every industry inherits.
  business_category_id: Joi.number().integer().allow(null).optional(),
  section_key:          key.required(),
  eyebrow:              Joi.string().max(150).allow('', null).optional(),
  heading:              Joi.string().max(255).allow('', null).optional(),
  subheading:           Joi.string().allow('', null).optional(),
  image_s3_key:         Joi.string().max(500).allow('', null).optional(),
  display_order:        Joi.number().integer().optional(),
  is_active:            Joi.number().integer().valid(0, 1).optional(),
});

const updatePageSectionSchema = Joi.object({
  page_key:             key,
  business_category_id: Joi.number().integer().allow(null),
  section_key:          key,
  eyebrow:              Joi.string().max(150).allow('', null),
  heading:              Joi.string().max(255).allow('', null),
  subheading:           Joi.string().allow('', null),
  image_s3_key:         Joi.string().max(500).allow('', null),
  display_order:        Joi.number().integer(),
  is_active:            Joi.number().integer().valid(0, 1),
}).min(1);

// ---- Page section items ----
// Every text field is optional because the three blocks in the design need
// different subsets — a chip is a bare `title`, a feature card is title + body +
// icon. `.or()` keeps a wholly empty item out of the table.
const createPageSectionItemSchema = Joi.object({
  section_id:    Joi.number().integer().required(),
  title:         Joi.string().max(200).allow('', null).optional(),
  body:          Joi.string().allow('', null).optional(),
  icon_s3_key:   Joi.string().max(500).allow('', null).optional(),
  link_url:      Joi.string().max(500).allow('', null).optional(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().integer().valid(0, 1).optional(),
}).or('title', 'body', 'icon_s3_key');

const updatePageSectionItemSchema = Joi.object({
  section_id:    Joi.number().integer(),
  title:         Joi.string().max(200).allow('', null),
  body:          Joi.string().allow('', null),
  icon_s3_key:   Joi.string().max(500).allow('', null),
  link_url:      Joi.string().max(500).allow('', null),
  display_order: Joi.number().integer(),
  is_active:     Joi.number().integer().valid(0, 1),
}).min(1);

// ---- Clone defaults into an industry ----
const clonePageSectionsSchema = Joi.object({
  page_key:             key.default('industry'),
  business_category_id: Joi.number().integer().required(),
  // Omit to clone every default for the page.
  section_keys:         Joi.array().items(key).min(1).unique().optional(),
});

module.exports = {
  createPageSectionSchema, updatePageSectionSchema,
  createPageSectionItemSchema, updatePageSectionItemSchema,
  clonePageSectionsSchema,
};
