const Joi = require('joi');

// PUT /notifications/settings — the whole set of per-category toggles the user
// changed. A list rather than a map so the payload is self-describing and one
// unknown category fails loudly instead of being silently dropped.
const updateNotificationSettingsSchema = Joi.object({
  settings: Joi.array().items(
    Joi.object({
      category_uid: Joi.string().uuid().required(),
      in_app:       Joi.boolean().required(),
    }),
  ).min(1).max(50).required(),
});

module.exports = { updateNotificationSettingsSchema };
