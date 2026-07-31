const Joi = require('joi');

const createAdminSchema = Joi.object({
  name:     Joi.string().min(1).max(100).required(),
  email:    Joi.string().email().required(),
  password: Joi.string().min(8).max(100).required(),
  role_id:  Joi.number().integer().required(),
});

const updateAdminSchema = Joi.object({
  name:      Joi.string().min(1).max(100).optional(),
  role_id:   Joi.number().integer().optional(),
  is_active: Joi.number().valid(0, 1).optional(),
  password:  Joi.string().min(8).max(100).optional(),
}).min(1);

const userStatusSchema = Joi.object({
  is_active: Joi.number().valid(0, 1).required(),
});

const adminStatusSchema = Joi.object({
  is_active: Joi.number().valid(0, 1).required(),
});

const createRoleSchema = Joi.object({
  name:        Joi.string().min(1).max(100).required(),
  description: Joi.string().allow('').optional(),
  permissions: Joi.array().items(Joi.string()).required(),
  // is_system is intentionally omitted: roles created via the API are never system
  // roles. Joi rejects it as an unknown key (400) if a client tries to send it.
});

const updateRoleSchema = Joi.object({
  name:        Joi.string().min(1).max(100).optional(),
  description: Joi.string().allow('').optional(),
  permissions: Joi.array().items(Joi.string()).optional(),
}).min(1);

module.exports = { createAdminSchema, updateAdminSchema, userStatusSchema, adminStatusSchema, createRoleSchema, updateRoleSchema };
