const Joi = require('joi');
const { IMAGE_SLOTS, ASSET_TYPES } = require('../services/upload.service');

// Typed target — the server derives the final key from this (client never sends a raw key).
const targetSchema = Joi.object({
  type:         Joi.string().valid('image_slot', 'asset', 'template_file').required(),
  slot:         Joi.when('type', { is: 'image_slot',    then: Joi.string().valid(...Object.keys(IMAGE_SLOTS)).required(), otherwise: Joi.forbidden() }),
  asset_type:   Joi.when('type', { is: 'asset',         then: Joi.string().valid(...ASSET_TYPES).required(),            otherwise: Joi.forbidden() }),
  template_uid: Joi.when('type', { is: 'template_file', then: Joi.string().uuid().required(),                            otherwise: Joi.forbidden() }),
});

const presignSchema = Joi.object({
  target:       targetSchema.required(),
  filename:     Joi.string().min(1).max(200).required(),
  content_type: Joi.string().max(100).optional(),
});

const multipartInitiateSchema = presignSchema;

const presignPartsSchema = Joi.object({
  key:          Joi.string().min(1).max(600).required(),
  upload_id:    Joi.string().min(1).max(400).required(),
  part_numbers: Joi.array().items(Joi.number().integer().min(1).max(10000)).min(1).required(),
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
  presignSchema, multipartInitiateSchema, presignPartsSchema, completeSchema, abortSchema, confirmSchema,
};
