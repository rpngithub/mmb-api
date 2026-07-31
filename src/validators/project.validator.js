const Joi = require('joi');

const createProjectSchema = Joi.object({
  name:        Joi.string().min(1).max(200).required(),
  business_id: Joi.number().integer().optional(),
  template_id: Joi.number().integer().optional(),
  size_id:     Joi.number().integer().optional(),
  content:     Joi.string().optional(),
});

const updateProjectSchema = Joi.object({
  name:    Joi.string().min(1).max(200).optional(),
  content: Joi.string().optional(),
  status:  Joi.string().valid('draft', 'published', 'archived').optional(),
});

const createExportSchema = Joi.object({
  export_type: Joi.string().valid('download', 'share').required(),
  platform:    Joi.string().valid('whatsapp', 'instagram', 'facebook', 'direct').optional(),
  s3_key:      Joi.string().max(500).optional(),
});

module.exports = { createProjectSchema, updateProjectSchema, createExportSchema };
