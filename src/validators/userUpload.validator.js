const Joi = require('joi');
const { SLOTS, ALLOWED_CONTENT_TYPES } = require('../services/userUpload.service');

// One cap for every batch on this flow. Presign and confirm MUST agree: a client
// that presigned 20 keys has to be able to confirm all 20 in one call, and a
// mismatch would only surface at step 3, with the files already uploaded.
const MAX_BATCH = 20;

// The client picks a slot; the server derives the key from the authenticated
// caller. There is deliberately no way to send a key or a prefix.
const targetSchema = Joi.object({
  slot: Joi.string().valid(...Object.keys(SLOTS)).required(),
});
const contentTypeSchema = Joi.string().valid(...ALLOWED_CONTENT_TYPES);

// Presign takes one file (the original shape, unchanged) or a batch under
// `files`. Written as one object with an xor rather than Joi.alternatives so a bad
// slot still reports itself as `files[3].target.slot` — alternatives collapse
// every branch's error into one "does not match any of the allowed types", which
// is useless to a client uploading twenty files at once.
const presignSchema = Joi.object({
  target:       targetSchema.optional(),
  filename:     Joi.string().min(1).max(200).optional(),
  content_type: contentTypeSchema.optional(),
  files: Joi.array().items(Joi.object({
    target:       targetSchema.required(),
    filename:     Joi.string().min(1).max(200).required(),
    content_type: contentTypeSchema.optional(),
  })).min(1).max(MAX_BATCH).optional(),
})
  .xor('target', 'files')                          // one shape or the other, never both
  .with('target', 'filename')                      // the single shape still needs its filename
  .without('files', ['filename', 'content_type']);  // those live per item in a batch

// Two shapes. `keys` is the original; `uploads` carries the grid metadata the
// media library needs (dimensions and the user's own filename), which the server
// cannot work out for itself. Exactly one must be sent.
const confirmSchema = Joi.object({
  keys: Joi.array().items(Joi.string().min(1).max(600)).min(1).max(MAX_BATCH).optional(),
  uploads: Joi.array().items(Joi.object({
    key:      Joi.string().min(1).max(600).required(),
    width:    Joi.number().integer().min(1).max(100000).optional(),
    height:   Joi.number().integer().min(1).max(100000).optional(),
    filename: Joi.string().max(255).allow('', null).optional(),
  })).min(1).max(MAX_BATCH).optional(),
}).xor('keys', 'uploads');

// The list endpoint's query params are sanitised in the service (unknown slot
// falls back to the default, limit/offset are clamped) rather than validated
// here — `validate` only inspects req.body, and this matches how the other list
// endpoints in this codebase handle their filters.

module.exports = { presignSchema, confirmSchema, MAX_BATCH };
