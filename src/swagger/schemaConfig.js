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
  globalExclude: [
    'password_hash', 'otp_hash', 'refresh_token_hash', 'prev_refresh_token_hash', 'razorpay_signature',
  ],

  // Internal/auth tables not exposed through the API.
  UserSession:          { skip: true },
  TokenBlacklist:       { skip: true },
  OtpCode:              { skip: true },
  FailedLoginAttempt:   { skip: true },
  BusinessCategoryTag:  { skip: true },
  BusinessCategoryRelated: { skip: true },
  BusinessTag:          { skip: true },
  UserPreference:       { skip: true },   // exposed through the shaped /users/me/preferences response
  UserLanguage:         { skip: true },   // join table behind Preferred Languages
  FontLanguage:         { skip: true },   // join table behind a font's script coverage
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

  // The storage ledger doubles as the "My Uploads" media library, so the row IS a
  // response shape — but only these columns: `id` and `user_id` stay internal, and
  // `s3_key` is what the client prepends cdn_base_url to.
  UserUpload: {
    include: ['uid', 's3_key', 'slot', 'bytes', 'content_type', 'width', 'height', 'original_filename', 'created_at'],
    add: {
      slot: {
        type: 'string',
        enum: ['media_library', 'profile_photo', 'business_logo', 'business_cover', 'product_image', 'brand_font'],
      },
      bytes: { type: 'integer', description: 'Charged against the plan storage quota; refunded on delete' },
    },
  },

  // A font as the API returns it: the family row plus its files and script
  // coverage. `user_id` is internal — `is_own` is the client-facing form of it.
  Font: {
    exclude: ['user_id'],
    add: {
      is_own:    { type: 'boolean', description: 'true when the caller uploaded this font; false for the curated library' },
      is_locked: {
        type: 'boolean',
        description: 'A premium library font the caller\'s plan does not include. It is still listed so the user can see what they would get, but `FontFiles` is withheld until they upgrade.',
      },
      FontFiles: {
        type: 'array',
        description: 'One entry per (weight, style, format). Absent when `is_locked`.',
        items: { $ref: '#/components/schemas/FontFile' },
      },
      Languages: {
        type: 'array',
        description: 'Scripts this font can render. EMPTY means unspecified, and an unspecified font is offered everywhere rather than nowhere.',
        items: { $ref: '#/components/schemas/Language' },
      },
    },
  },

  // Feedback is read-only for admins and always carries its submitter — there is
  // nobody to follow up with otherwise.
  Feedback: {
    add: { User: { $ref: '#/components/schemas/User' } },
  },

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

  // A store frame. `content` is the design payload and is served only to an owner,
  // so it is absent from every list and from a locked detail response.
  Frame: {
    views: {
      // Public/store shape: hides the admin-only creator, adds the computed flags.
      Frame: {
        exclude: ['created_by'],
        add: {
          owned:     { type: 'boolean', description: 'true when the frame is in the caller\'s My Frames. Always false for guests. This — not `is_locked` — is what governs whether `content` is returned.' },
          is_locked: { type: 'boolean', description: 'A premium frame the caller has not bought: "costs money you have not paid". Means the same on a list card and on the detail response, so one padlock badge can be driven from it. A free frame is never locked, but its `content` still arrives only after it has been added. Note frames are bought per frame — a paid PLAN never unlocks one.' },
          strike_price: { type: 'number', nullable: true, description: 'Display-only "was" price, struck through beside `price`. Nothing is ever charged against it.' },
        },
      },
      // Admin shape: the full row plus the publish-checklist signals the list adds,
      // so the panel can flag incomplete frames without a request per row.
      FrameAdmin: {
        add: {
          has_content:   { type: 'integer', description: '1 when the design payload is set' },
          has_thumbnail: { type: 'integer', description: '1 when thumbnail_s3_key is set' },
          is_publishable: { type: 'boolean', description: 'true when `status` may be set to `active` — i.e. `missing_for_publish` is empty' },
          missing_for_publish: {
            type: 'array',
            description: 'Exactly what the publish gate would reject, one entry per unmet requirement. Empty for a publishable frame.',
            items: {
              type: 'object',
              properties: {
                field:   { type: 'string', example: 'category_id' },
                message: { type: 'string', example: 'A frame category is required' },
              },
            },
          },
        },
      },
    },
  },

  // "My Frames" — an ownership record, so it always carries the frame it owns.
  // `payment_id` is internal plumbing between the purchase and the webhook.
  UserFrame: {
    exclude: ['payment_id'],
    add: { Frame: { $ref: '#/components/schemas/Frame' } },
  },

  // A top-up pack on the shelf. Prices are stored pre-tax, so the store shape adds
  // the tax-inclusive figure the buyer is actually charged.
  QuotaPack: {
    views: {
      QuotaPack: {
        exclude: ['created_by'],
        add: {
          feature: {
            type: 'object',
            description: 'The feature this pack tops up.',
            properties: {
              key:   { type: 'string', example: 'ai_credits' },
              label: { type: 'string', example: 'AI Credits' },
              unit:  { type: 'string', enum: ['count', 'MB'], description: 'The unit `quantity` is expressed in.' },
            },
          },
          gst_amount:   { type: 'number', description: 'GST added on top of `price`.' },
          total_price:  { type: 'number', description: 'What Razorpay is actually asked for. Show THIS on the card — `price` is pre-tax.' },
          strike_price: { type: 'number', nullable: true, description: 'Display-only "was" price, struck through beside `price`. Nothing is ever charged against it.' },
        },
      },
      // Admin shape: the full row plus the publish-checklist signals the list adds.
      QuotaPackAdmin: {
        add: {
          is_publishable: { type: 'boolean', description: 'true when `status` may be set to `active` — i.e. `missing_for_publish` is empty' },
          missing_for_publish: {
            type: 'array',
            description: 'Exactly what the publish gate would reject, one entry per unmet requirement. Empty for a publishable pack.',
            items: {
              type: 'object',
              properties: {
                field:   { type: 'string', example: 'quantity' },
                message: { type: 'string', example: 'Quantity must be above zero' },
              },
            },
          },
        },
      },
    },
  },

  // A purchased or hand-granted block of quota — the balance itself, not a cache
  // of it. `consumed` only moves for monthly features (AI credits): storage is a
  // level, so its grant just raises the ceiling and freeing space returns it.
  //
  // `payment_id` is kept, unlike UserFrame's: grants are only ever served on
  // admin routes, and an admin investigating a disputed balance wants the link to
  // the payment that funded it.
  UserQuotaGrant: {},

  // Internal ledger behind the usage breakdown; surfaced only in aggregate, as the
  // `breakdown` array on GET /quota/usage.
  QuotaUsageEvent: { skip: true },

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

  // The public pricing card. `features` is NOT the raw plan_features join — the
  // service flattens each row into a renderable line (see utils/planFeatures), so
  // `display_label` is always populated and `enabled` says tick vs greyed-out.
  Plan: {
    add: {
      PlanBillingOptions: { type: 'array', items: { $ref: '#/components/schemas/PlanBillingOption' } },
      coupons:            { type: 'array', items: { $ref: '#/components/schemas/CouponPublic' } },
      features: {
        type: 'array',
        description: 'Card-visible features (show_on_card=1), ordered by display_order',
        items: {
          type: 'object',
          properties: {
            key:           { type: 'string', example: 'ai_bg_remover', description: 'Stable FeatureType key — use this for icons/logic, never the label' },
            label:         { type: 'string', example: 'AI BG remover credits', description: 'Raw feature name, without the quantity' },
            display_label: { type: 'string', example: '500 AI BG remover credits', description: 'Ready-to-render line, never null. The admin override when set, otherwise derived from value + label' },
            value:         { type: 'integer', example: 500, description: '-1 = unlimited, 0 = not included in this plan' },
            data_type:     { type: 'string', enum: ['integer', 'boolean'] },
            enabled:       { type: 'boolean', description: 'false when the plan does not include the feature (boolean 0 / integer 0) — render the row greyed out' },
            unlimited:     { type: 'boolean', description: 'true when value is -1' },
            display_order: { type: 'integer' },
          },
        },
      },
    },
  },

  // Hide payment gateway internals from the user-facing payment shape.
  Payment: { exclude: ['razorpay_order_id'] },

  // Users: hide the gateway customer id.
  User: {
    exclude: ['razorpay_customer_id'],
    // Derived fields (see user.service#getProfile), not columns.
    add: {
      has_password: {
        type: 'boolean',
        description: 'False for OTP-only accounts — show "Set password" rather than "Change password".',
      },
      onboarding: {
        type: 'object',
        description: 'Where the signup flow stands, so the app knows which screen to resume on.',
        properties: {
          account_type: { type: 'string', enum: ['business', 'personal'], nullable: true },
          has_business: { type: 'boolean' },
          completed:    { type: 'boolean' },
        },
      },
    },
  },
};
