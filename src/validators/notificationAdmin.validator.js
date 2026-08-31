const Joi = require('joi');

const TRIGGER_TYPES = ['event', 'scheduled', 'behavioral', 'recurring', 'manual'];
const ACCOUNT_TYPES = ['all', 'business', 'personal'];
const PLANS         = ['all', 'free', 'paid', 'trial'];
const DISPLAY       = ['low', 'normal', 'high'];
const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed'];

// ---- Notification categories ----------------------------------------------

const categoryFields = {
  name:          Joi.string().min(1).max(100),
  // Derived from `name` on create when omitted (adminCrud `autoSlug`), and never
  // re-derived on rename — the app deep-links by slug.
  slug:          Joi.string().max(120),
  description:   Joi.string().allow('', null),
  icon:          Joi.string().max(60).allow('', null),
  display_order: Joi.number().integer().min(0),
  is_active:     Joi.number().valid(0, 1),
};

const createNotificationCategorySchema = Joi.object({
  ...categoryFields, name: categoryFields.name.required(),
});
const updateNotificationCategorySchema = Joi.object({ ...categoryFields }).min(1);

// ---- Notification templates -------------------------------------------------

const templateFields = {
  // snake_case and immutable once seeded — services/notificationTemplateGate.js
  // rejects a change on a system row. The pattern is enforced here so a new
  // admin-authored template cannot introduce a code that reads badly in a
  // dedupe_key (which is lowercased and colon-delimited).
  code: Joi.string().pattern(/^[a-z][a-z0-9_]{2,79}$/).messages({
    'string.pattern.base': 'code must be lowercase snake_case, 3-80 characters, starting with a letter',
  }),
  category_id:  Joi.number().integer().allow(null),
  title:        Joi.string().min(1).max(200),
  body:         Joi.string().min(1).max(2000),
  cta_label:    Joi.string().max(100).allow('', null),
  // An app route key, not a URL — every notification lands in-product.
  cta_action:   Joi.string().max(100).allow('', null),
  cta_params:   Joi.object().allow(null),
  image_s3_key: Joi.string().max(500).allow('', null),
  // NOTE: `variables` is deliberately NOT here. It is the list of values the
  // trigger can supply, which is decided by the code that dispatches the
  // notification — not by whoever is editing the wording. The write gate treats it
  // as immutable on built-in templates and derives it from the copy on
  // admin-authored ones, so the admin panel never has to send or maintain it.
  // See services/notificationTemplateGate.js.
  variable_defaults: Joi.object().allow(null),
  trigger_type:      Joi.string().valid(...TRIGGER_TYPES),
  trigger_config:    Joi.object().allow(null),
  audience_account_type: Joi.string().valid(...ACCOUNT_TYPES),
  audience_plan:         Joi.string().valid(...PLANS),
  // NOTE: `priority` (send-order tiebreak when a user's daily cap is reached) is
  // also absent. It is internal arbitration between notifications, set sensibly at
  // seed time, and nothing an admin has the context to tune — exposing it only
  // invited confusion with `display_priority`, which is the one that changes what
  // the user sees.
  display_priority: Joi.string().valid(...DISPLAY),
  is_promotional:   Joi.number().valid(0, 1),
  // "once a week (max)" -> 168. Capped at a year: anything longer is a lifetime
  // cap, which is what max_occurrences is for.
  cooldown_hours:   Joi.number().integer().min(0).max(8760).allow(null),
  max_occurrences:  Joi.number().integer().min(1).max(1000).allow(null),
  is_dismissible:   Joi.number().valid(0, 1),
  expires_after_days: Joi.number().integer().min(1).max(365).allow(null),
  is_active:        Joi.number().valid(0, 1),
};

const createNotificationTemplateSchema = Joi.object({
  ...templateFields,
  code:         templateFields.code.required(),
  title:        templateFields.title.required(),
  body:         templateFields.body.required(),
  trigger_type: templateFields.trigger_type.required(),
});
const updateNotificationTemplateSchema = Joi.object({ ...templateFields }).min(1);

// ---- Campaigns ---------------------------------------------------------------

// The audience segment. `.unknown(false)` is load-bearing: this object is turned
// into a WHERE clause by notificationSegment.js, and an unrecognised key must be a
// 400 at save time rather than a filter that is silently ignored — the failure
// mode there is sending to a far larger audience than the admin approved.
const audienceSchema = Joi.object({
  account_type:      Joi.string().valid(...ACCOUNT_TYPES),
  plan:              Joi.string().valid(...PLANS),
  industry_ids:      Joi.array().items(Joi.number().integer()).max(100),
  has_business:      Joi.boolean(),
  onboarding:        Joi.string().valid('complete', 'incomplete'),
  inactive_days_min: Joi.number().integer().min(0).max(3650),
  inactive_days_max: Joi.number().integer().min(0).max(3650),
  signed_up_after:   Joi.date().iso(),
  signed_up_before:  Joi.date().iso(),
  cities:            Joi.array().items(Joi.string().max(100)).max(50),
  // An explicit recipient list, for a targeted announcement. Bounded because the
  // fan-out reads it into one IN clause.
  user_uids:         Joi.array().items(Joi.string().uuid()).max(1000),
}).unknown(false);

const campaignFields = {
  name:         Joi.string().min(1).max(200),
  template_id:  Joi.number().integer().allow(null),
  category_id:  Joi.number().integer().allow(null),
  title:        Joi.string().max(200).allow('', null),
  body:         Joi.string().max(2000).allow('', null),
  cta_label:    Joi.string().max(100).allow('', null),
  cta_action:   Joi.string().max(100).allow('', null),
  cta_params:   Joi.object().allow(null),
  image_s3_key: Joi.string().max(500).allow('', null),
  audience:     audienceSchema,
  scheduled_at: Joi.date().iso().allow(null),
  // Bypasses the fatigue caps only, never marketing consent. Deliberate and
  // audited — see the migration comment.
  bypass_fatigue: Joi.number().valid(0, 1),
};

const createNotificationCampaignSchema = Joi.object({
  ...campaignFields, name: campaignFields.name.required(),
});
// `status` is deliberately absent: it moves through the lifecycle endpoints
// (schedule / send-now / cancel), never by a direct PATCH.
const updateNotificationCampaignSchema = Joi.object({ ...campaignFields }).min(1);

const scheduleCampaignSchema = Joi.object({
  scheduled_at: Joi.date().iso().greater('now').required(),
});

module.exports = {
  createNotificationCategorySchema,
  updateNotificationCategorySchema,
  createNotificationTemplateSchema,
  updateNotificationTemplateSchema,
  createNotificationCampaignSchema,
  updateNotificationCampaignSchema,
  scheduleCampaignSchema,
  audienceSchema,
  CAMPAIGN_STATUSES,
};
