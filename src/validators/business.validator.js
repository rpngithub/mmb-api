const Joi = require('joi');

// A day is either closed (null) or an { open, close } pair in "HH:MM" form.
const dayHoursSchema = Joi.object({
  open:  Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
  close: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
}).allow(null);

const createBusinessSchema = Joi.object({
  name:        Joi.string().min(2).max(200).required(),
  // `industry` is the public name for the business category — a friendly ref
  // (slug / uid / numeric id) resolved to category_id server-side. `category_id`
  // is the deprecated legacy form (still accepted).
  industry:    Joi.string().optional(),
  category_id: Joi.number().integer().optional(),
  description: Joi.string().optional(),
  city:        Joi.string().max(100).optional(),
  state:       Joi.string().max(100).optional(),
  address:     Joi.string().optional(),
  latitude:    Joi.number().min(-90).max(90).optional(),
  longitude:   Joi.number().min(-180).max(180).optional(),
  phone:       Joi.string().max(20).optional(),
  whatsapp:    Joi.string().max(20).optional(),
  email:       Joi.string().email().max(150).optional(),
  website:     Joi.string().uri().max(255).optional(),
  social_links: Joi.object().pattern(Joi.string(), Joi.string().uri().allow('')).optional(),
  operating_hours: Joi.object({
    mon: dayHoursSchema, tue: dayHoursSchema, wed: dayHoursSchema, thu: dayHoursSchema,
    fri: dayHoursSchema, sat: dayHoursSchema, sun: dayHoursSchema,
  }).optional(),
});

const updateBusinessSchema = createBusinessSchema.fork(Object.keys(createBusinessSchema.describe().keys), (s) => s.optional());

// "Add to your Business": adopt a theme (identified by its public uid) into a business.
const adoptThemeSchema = Joi.object({
  theme_uid: Joi.string().guid().required(),
});

module.exports = { createBusinessSchema, updateBusinessSchema, adoptThemeSchema };
