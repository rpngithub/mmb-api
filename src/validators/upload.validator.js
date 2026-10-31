const Joi = require('joi');
const { IMAGE_SLOTS, ASSET_TYPES } = require('../services/upload.service');

// Typed target — the server derives the final key from this (client never sends a raw key).
const targetSchema = Joi.object({
  type:              Joi.string().valid('image_slot', 'asset', 'template_file', 'frame_file').required(),
  slot:              Joi.when('type', { is: 'image_slot',    then: Joi.string().valid(...Object.keys(IMAGE_SLOTS)).required(), otherwise: Joi.forbidden() }),
  asset_type:        Joi.when('type', { is: 'asset',         then: Joi.string().valid(...ASSET_TYPES).required(),            otherwise: Joi.forbidden() }),
  template_uid:      Joi.when('type', { is: 'template_file', then: Joi.string().uuid().required(),                            otherwise: Joi.forbidden() }),
  frame_version_uid: Joi.when('type', { is: 'frame_file',    then: Joi.string().uuid().required(),                            otherwise: Joi.forbidden() }),
});

// One file. Kept as its own schema because multipart initiate takes EXACTLY this
// and must not inherit presign's batch form — a multipart upload is one key, one
// upload_id, and `files: [...]` there would be silently accepted and half-ignored.
// `size` is the file's byte count. Optional (the panel may not send it yet); when
// sent, content_type must be too, since the URL is then signed for both. Allowed
// types and the size caps are app_settings, checked in the service.
const sizeSchema = Joi.number().integer().min(1);

const fileSchema = Joi.object({
  target:       targetSchema.required(),
  filename:     Joi.string().min(1).max(200).required(),
  content_type: Joi.string().max(100).optional(),
  size:         sizeSchema.optional(),
}).with('size', 'content_type');

// Presign takes one file or a batch. Written as one object with an xor rather than
// Joi.alternatives so a bad target still reports itself as `files.3.target.slot`;
// alternatives collapse every branch into one unhelpful "does not match any of the
// allowed types".
//
// A hard ceiling only: the real per-request counts are app_settings
// (`upload_admin_*_batch_max_files`, 50 non-video files and 10 videos by
// default), checked in the service so an admin can tune them.
const MAX_BATCH = 100;

const presignSchema = Joi.object({
  target:       targetSchema.optional(),
  filename:     Joi.string().min(1).max(200).optional(),
  content_type: Joi.string().max(100).optional(),
  size:         sizeSchema.optional(),
  files:        Joi.array().items(fileSchema).min(1).max(MAX_BATCH).optional(),
})
  .xor('target', 'files')
  .with('target', 'filename')
  .with('size', 'content_type')
  .without('files', ['filename', 'content_type', 'size']);

const multipartInitiateSchema = fileSchema;

const presignPartsSchema = Joi.object({
  key:          Joi.string().min(1).max(600).required(),
  upload_id:    Joi.string().min(1).max(400).required(),
  part_numbers: Joi.array().items(Joi.number().integer().min(1).max(10000)).min(1).required(),
  // The same `size` sent to initiate: each part is then signed for its exact length.
  size:         sizeSchema.optional(),
});

const completeSchema = Joi.object({
  key:       Joi.string().min(1).max(600).required(),
  upload_id: Joi.string().min(1).max(400).required(),
  parts:     Joi.array().items(Joi.object({
    part_number: Joi.number().integer().min(1).max(10000).required(),
    etag:        Joi.string().min(1).max(200).required(),
  })).min(1).required(),
});

const abortSchema = Joi.object({
  key:       Joi.string().min(1).max(600).required(),
  upload_id: Joi.string().min(1).max(400).required(),
});

const confirmSchema = Joi.object({
  keys: Joi.array().items(Joi.string().min(1).max(600)).min(1).required(),
});

module.exports = {
  presignSchema, multipartInitiateSchema, presignPartsSchema, completeSchema, abortSchema, confirmSchema, MAX_BATCH,
};
