const Joi = require('joi');

// The ONLY fields a user may set on themselves. Everything else on the users
// table — password_hash, is_active, razorpay_customer_id, uid, phone — is
// server-owned and must never be writable from a profile PATCH, so this schema
// is an allow-list rather than a set of per-field rules. (`phone` is the login
// identity and changes only through an OTP-verified flow, which does not exist
// yet; `email` is not verified either, but it is display/contact data only.)
const updateProfileSchema = Joi.object({
  name:  Joi.string().min(1).max(100).optional(),
  email: Joi.string().email().max(255).allow(null, '').optional(),
  // Step 2 of signup, "What brings you here?". Settable only while onboarding is
  // still open — the service rejects it afterwards.
  account_type: Joi.string().valid('business', 'personal').optional(),
  // A key from POST /uploads/presign (slot profile_photo); null clears the photo.
  profile_photo_s3_key: Joi.string().max(500).allow(null, '').optional(),
}).min(1);

// 8 chars matches the admin login rule, so the two password paths agree.
const password = Joi.string().min(8).max(128);

const setPasswordSchema = Joi.object({
  new_password: password.required(),
});

const changePasswordSchema = Joi.object({
  current_password: Joi.string().required(),
  new_password:     password.required(),
});

// Partial update — every field optional, but an empty body is a no-op worth
// rejecting so a broken client is visible rather than silently doing nothing.
//
// `languages` is "Preferred Languages": CONTENT languages selecting which
// templates the user is shown, not the app's UI language. It is a multi-select
// and a FULL REPLACE — send the whole set. `[]` clears it, which puts the user
// back on the default (English). Entries are codes ('ta'), uids or numeric ids,
// validated against the admin-managed catalogue in the service.
const updatePreferencesSchema = Joi.object({
  languages:       Joi.array().items(Joi.alternatives(Joi.string().max(36), Joi.number().integer().positive())).max(20).unique().optional(),
  notify_push:     Joi.boolean().optional(),
  notify_email:    Joi.boolean().optional(),
  notify_whatsapp: Joi.boolean().optional(),
}).min(1);

module.exports = { updateProfileSchema, setPasswordSchema, changePasswordSchema, updatePreferencesSchema };
