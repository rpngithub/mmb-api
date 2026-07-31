const Joi = require('joi');

const TYPES = ['string', 'integer', 'boolean', 'json'];

// When type is 'json', the value must itself be valid JSON (config.service parses it).
const valueSchema = Joi.alternatives().conditional('type', {
  is: 'json',
  then: Joi.string().custom((v, helpers) => {
    try { JSON.parse(v); return v; } catch { return helpers.error('any.invalid'); }
  }).allow(null).messages({ 'any.invalid': 'value must be valid JSON when type is json' }),
  otherwise: Joi.string().allow('', null),
});

const createAppSettingSchema = Joi.object({
  key:         Joi.string().min(1).max(100).required(),
  value:       valueSchema.optional(),
  type:        Joi.string().valid(...TYPES).optional(),
  description: Joi.string().allow('', null).optional(),
  group:       Joi.string().max(50).allow('', null).optional(),
  is_public:   Joi.number().valid(0, 1).optional(),
});

const updateAppSettingSchema = Joi.object({
  key:         Joi.string().min(1).max(100).optional(),
  value:       valueSchema.optional(),
  type:        Joi.string().valid(...TYPES).optional(),
  description: Joi.string().allow('', null).optional(),
  group:       Joi.string().max(50).allow('', null).optional(),
  is_public:   Joi.number().valid(0, 1).optional(),
}).min(1);

module.exports = { createAppSettingSchema, updateAppSettingSchema };
