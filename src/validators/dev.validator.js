const Joi = require('joi');

// Same phone pattern as sendOtpSchema; otpHelper.toLocalNumber narrows it to an
// Indian mobile and returns a 400 if it isn't one.
const testSmsSchema = Joi.object({
  phone:   Joi.string().pattern(/^\+?[1-9]\d{9,14}$/).required(),
  dry_run: Joi.boolean().default(false),
});

module.exports = { testSmsSchema };
