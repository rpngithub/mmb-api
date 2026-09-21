const Joi = require('joi');
const { SPECIAL_EVENT_TYPES } = require('../constants/specialEventTypes');

// Recurring events store month-day "MM-DD" (e.g. "12-25"); one-offs store a
// concrete "YYYY-MM-DD". The public /special-events matching keys off these
// formats, so enforce them at admin-write time.
const MMDD     = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const fields = {
  name:             Joi.string().min(1).max(200),
  description:      Joi.string().allow('').optional(),
  thumbnail_s3_key: Joi.string().max(500).allow(null, '').optional(),
  banner_s3_key:    Joi.string().max(500).allow(null, '').optional(),
  type:         Joi.string().valid(...SPECIAL_EVENT_TYPES),
  event_date:   Joi.string().pattern(MMDD).message('event_date must be in MM-DD format (e.g. 12-25)'),
  full_date:    Joi.string().pattern(ISO_DATE).message('full_date must be in YYYY-MM-DD format'),
  is_recurring: Joi.number().valid(0, 1),
  is_active:    Joi.number().valid(0, 1),
};

// Create: name + type required, and the event must fall on *some* date.
const createSpecialEventSchema = Joi.object({
  ...fields,
  name: fields.name.required(),
  type: fields.type.required(),
}).or('event_date', 'full_date');

// Update: any subset, but at least one field.
const updateSpecialEventSchema = Joi.object(fields).min(1);

// Full-replace the templates linked to an event (curates the calendar's "event -> designs").
const setEventTemplatesSchema = Joi.object({
  template_ids: Joi.array().items(Joi.number().integer()).required(),
});

module.exports = { createSpecialEventSchema, updateSpecialEventSchema, setEventTemplatesSchema };
