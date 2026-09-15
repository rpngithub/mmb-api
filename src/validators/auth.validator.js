const Joi = require('joi');
const { USER_CLIENT_TYPES } = require('../utils/clientTypes');
const { toE164 }           = require('../utils/phone');

// India-only, stated up front. This used to admit any international number and
// leave otpHelper.toLocalNumber to refuse it at send time — after the OTP row had
// already been written. Accepts every spelling the clients use (+91, 91, 0, bare
// 10 digits, spaces/hyphens); the service canonicalises, this only decides yes/no.
const indianMobile = Joi.string().custom((value, helpers) => (
  toE164(value) ? value : helpers.message('Expected a 10-digit Indian mobile number, optionally prefixed with +91')
));

const sendOtpSchema = Joi.object({
  phone:   indianMobile.required(),
  purpose: Joi.string().valid('login', 'reset').required(),
});

const verifyOtpSchema = Joi.object({
  phone:           indianMobile.required(),
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
