const Joi = require('joi');
const { SLOTS } = require('../services/userUpload.service');
const { MAX_BYTES: POSTER_MAX_BYTES } = require('../services/projectThumbnail.service');

// A hard ceiling only. The real per-request limits are app_settings
// (`upload_user_*_batch_max_files`), checked in the service — they are per kind
// and admin-tunable, which a schema built at boot cannot follow. Presign and
// confirm share this ceiling so a presigned set can always be confirmed in one
// call, whatever an admin changes in between.
const MAX_BATCH = 100;

// The client picks a slot; the server derives the key from the authenticated
// caller. There is deliberately no way to send a key or a prefix.
const targetSchema = Joi.object({
  slot: Joi.string().valid(...Object.keys(SLOTS)).required(),
});
// The allowed types are settings too (`upload_user_*_types`), checked per slot in
// the service; the schema only bounds the string.
const contentTypeSchema = Joi.string().max(100);
// Bytes, as File.size reports it. Optional while older app builds that do not
// send it are still supported; when sent, content_type must be too, because the
// upload URL is then signed for both.
const sizeSchema = Joi.number().integer().min(1);

// Presign takes one file (the original shape, unchanged) or a batch under
// `files`. Written as one object with an xor rather than Joi.alternatives so a bad
// slot still reports itself as `files[3].target.slot` — alternatives collapse
// every branch's error into one "does not match any of the allowed types", which
// is useless to a client uploading twenty files at once.
const presignSchema = Joi.object({
  target:       targetSchema.optional(),
  filename:     Joi.string().min(1).max(200).optional(),
  content_type: contentTypeSchema.optional(),
  size:         sizeSchema.optional(),
  files: Joi.array().items(Joi.object({
    target:       targetSchema.required(),
    filename:     Joi.string().min(1).max(200).required(),
    content_type: contentTypeSchema.optional(),
    size:         sizeSchema.optional(),
  }).with('size', 'content_type')).min(1).max(MAX_BATCH).optional(),
})
  .xor('target', 'files')                                  // one shape or the other, never both
  .with('target', 'filename')                              // the single shape still needs its filename
  .with('size', 'content_type')
  .without('files', ['filename', 'content_type', 'size']); // those live per item in a batch

// Two shapes. `keys` is the original; `uploads` carries the grid metadata the
// media library needs (dimensions and the user's own filename, and for a video
// its duration and poster), which the server cannot work out for itself. Exactly
// one must be sent.
const confirmSchema = Joi.object({
  keys: Joi.array().items(Joi.string().min(1).max(600)).min(1).max(MAX_BATCH).optional(),
  uploads: Joi.array().items(Joi.object({
    key:         Joi.string().min(1).max(600).required(),
    width:       Joi.number().integer().min(1).max(100000).optional(),
    height:      Joi.number().integer().min(1).max(100000).optional(),
    filename:    Joi.string().max(255).allow('', null).optional(),
    // Videos only (the service refuses them on anything else). 24 h is a sanity
    // ceiling, not a product limit.
    duration_ms: Joi.number().integer().min(1).max(24 * 60 * 60 * 1000).optional(),
    // Base64 (or a data: URL) JPEG/PNG/WebP, ≤ 500 KB decoded — the same rules as
    // a project thumbnail. Bounded here so a huge string is refused unparsed.
    poster:      Joi.string().max(Math.ceil(POSTER_MAX_BYTES * 4 / 3) + 64).optional(),
  })).min(1).max(MAX_BATCH).optional(),
}).xor('keys', 'uploads');

// The list endpoint's query params are sanitised in the service (unknown slot
// falls back to the default, limit/offset are clamped) rather than validated
// here — `validate` only inspects req.body, and this matches how the other list
// endpoints in this codebase handle their filters.

module.exports = { presignSchema, confirmSchema, MAX_BATCH };
