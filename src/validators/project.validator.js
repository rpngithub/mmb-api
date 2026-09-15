const Joi = require('joi');
const { MAX_BYTES } = require('../services/projectThumbnail.service');

// The preview image, inline: `data:image/png;base64,…` (or the bare base64).
// Length here is only a coarse gate so an absurd payload is refused before it is
// decoded; the real limit, and the check that it is actually an image, is in
// projectThumbnail.service. Base64 is 4/3 the byte size, plus the data-URL prefix.
const thumbnail = Joi.string().max(Math.ceil(MAX_BYTES * 4 / 3) + 64);

const createProjectSchema = Joi.object({
  name:        Joi.string().min(1).max(200).required(),
  business_id: Joi.number().integer().optional(),
  template_id: Joi.number().integer().optional(),
  size_id:     Joi.number().integer().optional(),
  content:     Joi.string().optional(),
  thumbnail:   thumbnail.optional(),
});

const updateProjectSchema = Joi.object({
  name:      Joi.string().min(1).max(200).optional(),
  content:   Joi.string().optional(),
  status:    Joi.string().valid('draft', 'published', 'archived').optional(),
  thumbnail: thumbnail.optional(),
});

const createExportSchema = Joi.object({
  export_type: Joi.string().valid('download', 'share').required(),
  platform:    Joi.string().valid('whatsapp', 'instagram', 'facebook', 'direct').optional(),
  s3_key:      Joi.string().max(500).optional(),
});

module.exports = { createProjectSchema, updateProjectSchema, createExportSchema };
