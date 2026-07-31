// Controls how model-derived OpenAPI schemas are generated (src/swagger/modelSchemas.js).
//
// Per model you may set:
//   exclude: ['field', ...]   fields to hide
//   include: ['field', ...]   whitelist — if set, ONLY these are shown
//   add:     { name: 'string'|'integer'|'boolean'|{...schema} }   extra/computed fields
//   views:   { ViewName: { exclude/include/add } }   multiple named schemas for one model
//   skip:    true             do not generate a schema for this model
//
// A model with `views` produces one schema per view (named by the view key) and
// no base schema. Otherwise it produces one schema named after the model.

module.exports = {
  // Stripped from EVERY schema (sensitive / internal).
  globalExclude: ['password_hash', 'otp_hash', 'refresh_token_hash', 'razorpay_signature'],

  // Internal/auth tables not exposed through the API.
  UserSession:          { skip: true },
  TokenBlacklist:       { skip: true },
  OtpCode:              { skip: true },
  FailedLoginAttempt:   { skip: true },
  BusinessCategoryTag:  { skip: true },
  TemplateTag:          { skip: true },
  TemplateSizeMap:      { skip: true },
  VariantTemplate:      { skip: true },
  VariantPlanRestriction: { skip: true },
  VariantIndustry:      { skip: true },
  BusinessVariant:      { skip: true },
  BrandSeriesStylePersonality: { skip: true },
  BrandSeriesTag:       { skip: true },
  BrandSeriesColor:     { skip: true },
  TemplateBusinessCategory: { skip: true },
  AssetTag:             { skip: true },
  SpecialEventTemplate: { skip: true },
  CouponPlanRestriction:{ skip: true },

  // Example of field-level control + computed fields + multiple views.
  Template: {
    views: {
      // Public/browse shape: hides the admin-only creator, adds the computed lock flag.
      TemplatePublic: { exclude: ['created_by'], add: { is_locked: { type: 'boolean' } } },
      // Admin shape: the full row, plus the completeness signals the list adds so the
      // admin panel can flag incomplete templates without a request per row.
      TemplateAdmin:  {
        add: {
          tag_count:      { type: 'integer' },
          size_count:     { type: 'integer' },
          industry_count: { type: 'integer' },
          has_content:    { type: 'integer', description: '1 when a bundle has been uploaded' },
          has_thumbnail:  { type: 'integer', description: '1 when thumbnail_s3_key is set' },
        },
      },
    },
  },

  // Variant detail carries a computed lock flag (premium templates are plan-gated) and
  // the template tally shown on its card.
  Variant: {
    add: {
      is_locked:       { type: 'boolean' },
      templates_count: { type: 'integer' },
    },
  },

  // A brand series' lock state is a ROLLUP of its variants — gating itself lives on the
  // variant. `is_locked` is true only when every variant in the series is locked.
  BrandSeries: {
    add: {
      is_locked:               { type: 'boolean' },
      variants_count:          { type: 'integer' },
      templates_count:         { type: 'integer', description: 'Distinct active templates across all variants' },
      unlocked_variants_count: { type: 'integer' },
    },
  },

  // Coupons: the user-facing shape is deliberately narrow — the redemption rules
  // (usage counters, audience, plan scope) are enforced server-side and must not
  // leak to the FE, which would otherwise be tempted to re-implement them.
  Coupon: {
    views: {
      CouponPublic: { include: ['uid', 'code', 'title', 'discount_type', 'discount_value', 'valid_to'] },
      CouponAdmin:  {},
    },
  },

  // Hide payment gateway internals from the user-facing payment shape.
  Payment: { exclude: ['razorpay_order_id'] },

  // Users: hide the gateway customer id.
  User: { exclude: ['razorpay_customer_id'] },
};
