const Joi = require('joi');

// The five faces on the Feedback screen, worst to best. The rating is REQUIRED —
// it is what the form is for — and the note is optional, matching a SUBMIT button
// that enables as soon as a face is tapped.
const submitFeedbackSchema = Joi.object({
  rating:      Joi.number().integer().min(1).max(5).required(),
  message:     Joi.string().max(2000).allow('', null).optional(),
  // Support triage: which build a complaint came from is more reliable than
  // anything the user can tell you about it. Optional so the web client can omit them.
  app_version: Joi.string().max(30).allow('', null).optional(),
  platform:    Joi.string().max(30).allow('', null).optional(),
});

module.exports = { submitFeedbackSchema };
