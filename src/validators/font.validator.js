const Joi = require('joi');

// One physical file of a family. `format` is required because the browser needs
// to know what it is being handed; weight/style default to regular, which is what
// a user uploading a single file almost always means.
const fontFile = Joi.object({
  s3_key: Joi.string().max(500).required(),
  weight: Joi.number().integer().min(100).max(900).optional(),
  style:  Joi.string().valid('normal', 'italic').optional(),
  format: Joi.string().valid('woff2', 'woff', 'ttf', 'otf').required(),
});

// A user registering their own uploaded typeface. At least one file; the cap is
// generous enough for a full family (9 weights x 2 styles) without being unbounded.
const createOwnFontSchema = Joi.object({
  family: Joi.string().min(1).max(100).required(),
  files:  Joi.array().items(fontFile).min(1).max(20).required(),
});

// ---- Admin: the curated library ----
const createFontSchema = Joi.object({
  family:        Joi.string().min(1).max(100).required(),
  is_premium:    Joi.number().valid(0, 1).optional(),
  display_order: Joi.number().integer().optional(),
  is_active:     Joi.number().valid(0, 1).optional(),
});

const updateFontSchema = createFontSchema.fork(['family'], (s) => s.optional()).min(1);

// Full replace of a library font's files and of its script coverage.
const setFontFilesSchema = Joi.object({
  files: Joi.array().items(fontFile).min(1).max(20).required(),
});

const setFontLanguagesSchema = Joi.object({
  language_ids: Joi.array().items(Joi.number().integer().positive()).unique().required(),
});

module.exports = {
  createOwnFontSchema, createFontSchema, updateFontSchema,
  setFontFilesSchema, setFontLanguagesSchema,
};
