const Joi = require('joi');
const { USER_CLIENT_TYPES } = require('../utils/clientTypes');

const sendOtpSchema = Joi.object({
  phone:   Joi.string().pattern(/^\+?[1-9]\d{9,14}$/).required(),
  purpose: Joi.string().valid('login', 'reset').required(),
});

const verifyOtpSchema = Joi.object({
  phone:           Joi.string().required(),
  otp:             Joi.string().length(6).required(),
  purpose:         Joi.string().valid('login', 'reset').required(),
  // Enumerated, like `purpose` above — and notably excluding 'admin_panel', which
  // only admin login may set. See utils/clientTypes.
  client_mnemonic: Joi.string().valid(...USER_CLIENT_TYPES).required(),
});

const refreshSchema = Joi.object({
  refresh_token: Joi.string().required(),
});

const adminLoginSchema = Joi.object({
  email:    Joi.string().email().required(),
  password: Joi.string().min(8).required(),
});

module.exports = { sendOtpSchema, verifyOtpSchema, refreshSchema, adminLoginSchema };
