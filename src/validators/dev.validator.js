const Joi = require('joi');

// Same phone pattern as sendOtpSchema; otpHelper.toLocalNumber narrows it to an
// Indian mobile and returns a 400 if it isn't one.
const testSmsSchema = Joi.object({
  phone:   Joi.string().pattern(/^\+?[1-9]\d{9,14}$/).required(),
  dry_run: Joi.boolean().default(false),
});

// POST /dev/test-notification — put a notification in your OWN inbox so the app,
// the playground and Postman have something to read, mark read and dismiss.
//
// There is deliberately no recipient field: it always targets the caller. A dev
// tool that can push a notification into someone else's inbox is a spam endpoint,
// and this one is reachable on staging.
// NOTE: no .default() here on purpose. middlewares/validate.js only inspects Joi's
// `error` and discards the coerced value, so a schema default would never reach
// req.body — it would look like it worked and quietly send `undefined` onward. Both
// defaults are applied in the controller instead.
const testNotificationSchema = Joi.object({
  // Any active template's code. Optional; the controller falls back to a
  // transactional template with no placeholders, so an empty body works.
  code:      Joi.string().max(80),
  // Values for the template's {{placeholders}}, if it has any.
  variables: Joi.object(),
});

module.exports = { testSmsSchema, testNotificationSchema };
