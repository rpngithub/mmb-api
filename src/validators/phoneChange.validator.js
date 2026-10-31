const Joi = require('joi');
const { indianMobile } = require('./auth.validator');

// Same shape as the login OTP.
const otp = Joi.string().pattern(/^\d{6}$/).required()
  .messages({ 'string.pattern.base': 'OTP must be 6 digits' });

// The tokens we mail are 43 base64url characters; anything far off that is not ours.
const linkToken = Joi.string().pattern(/^[A-Za-z0-9_-]{20,200}$/).required()
  .messages({ 'string.pattern.base': 'Invalid link token' });

const otpSchema       = Joi.object({ otp });
const newPhoneSchema  = Joi.object({ phone: indianMobile.required() });

const linkSendOtpSchema = Joi.object({ token: linkToken, phone: indianMobile.required() });
const linkVerifySchema  = Joi.object({ token: linkToken, otp });

const verifyEmailSchema = Joi.object({ token: linkToken });

// null (or '') removes the address.
const changeEmailSchema = Joi.object({
  email: Joi.string().email().max(255).allow(null, '').required(),
  otp,
});

module.exports = {
  otpSchema, newPhoneSchema, linkSendOtpSchema, linkVerifySchema, verifyEmailSchema, changeEmailSchema, linkToken,
};
