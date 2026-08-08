const Joi = require('joi');
const { SLOTS, ALLOWED_CONTENT_TYPES } = require('../services/userUpload.service');

// The client picks a slot; the server derives the key from the authenticated
// caller. There is deliberately no way to send a key or a prefix.
const presignSchema = Joi.object({
  target: Joi.object({
    slot: Joi.string().valid(...Object.keys(SLOTS)).required(),
  }).required(),
  filename:     Joi.string().min(1).max(200).required(),
  content_type: Joi.string().valid(...ALLOWED_CONTENT_TYPES).optional(),
});

// Two shapes. `keys` is the original; `uploads` carries the grid metadata the
// media library needs (dimensions and the user's own filename), which the server
// cannot work out for itself. Exactly one must be sent.
const confirmSchema = Joi.object({
  keys: Joi.array().items(Joi.string().min(1).max(600)).min(1).max(20).optional(),
  uploads: Joi.array().items(Joi.object({
    key:      Joi.string().min(1).max(600).required(),
    width:    Joi.number().integer().min(1).max(100000).optional(),
    height:   Joi.number().integer().min(1).max(100000).optional(),
    filename: Joi.string().max(255).allow('', null).optional(),
  })).min(1).max(20).optional(),
}).xor('keys', 'uploads');

// The list endpoint's query params are sanitised in the service (unknown slot
// falls back to the default, limit/offset are clamped) rather than validated
// here — `validate` only inspects req.body, and this matches how the other list
// endpoints in this codebase handle their filters.

module.exports = { presignSchema, confirmSchema };
