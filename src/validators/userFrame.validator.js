const Joi = require('joi');

const createFrameSchema = Joi.object({
  name:       Joi.string().min(1).max(200).required(),
  s3_key:     Joi.string().max(500).required(),
  frame_type: Joi.string().valid('image', 'animated').optional(),
});

const updateFrameSchema = Joi.object({
  name:      Joi.string().min(1).max(200).optional(),
  is_active: Joi.number().valid(0, 1).optional(),
});

module.exports = { createFrameSchema, updateFrameSchema };
