const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/catalog.controller');
const optionalAuth = require('../middlewares/optionalAuth');
const rateLimiter  = require('../middlewares/rateLimiter');
const deprecated   = require('../middlewares/deprecated');

/**
 * @swagger
 * tags:
 *   - name: Catalog
 *     description: >
 *       Public catalog reads — no JWT required. A token (when present) raises the
 *       rate-limit tier and targets audience-specific content (e.g. banners).
 */

// Public reads: optionalAuth populates req.user when a token is sent; the
// tiered limiter then throttles guest < free < paid.
router.use(optionalAuth, rateLimiter.publicTiered);

/**
 * @swagger
 * /industries:
 *   get:
 *     summary: List active industries (business categories)
 *     description: >-
 *       The public "industry" catalogue. Same data and params as the deprecated
 *       `/business-categories` alias — new clients should call `/industries`.
 *       Flat by default; `tree=1` nests the whole hierarchy and `hierarchy=1`
 *       returns only the top-level industries.
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: tree
 *         description: >-
 *           When set (`tree=1`), returns the full active hierarchy nested parent→child —
 *           each row gains a `children` array (recursive, any depth), every level ordered
 *           by display_order. Overrides `hierarchy` and ignores `parent`/`parent_id`.
 *         schema: { type: string }
 *       - in: query
 *         name: hierarchy
 *         description: >-
 *           When set (`hierarchy=1`), returns only top-level industries (those with no
 *           parent) as a flat list, without their children. Ignores `parent`/`parent_id`.
 *         schema: { type: string }
 *       - in: query
 *         name: parent
 *         description: >-
 *           Filter by parent industry — accepts a slug (e.g. `restaurant-food`),
 *           a uid, or a numeric id. Use `null` for top-level industries.
 *           Ignored when `tree` or `hierarchy` is set.
 *         schema: { type: string }
 *       - in: query
 *         name: parent_id
 *         deprecated: true
 *         description: "Legacy numeric-id form of `parent` (still accepted; prefer `parent`)."
 *         schema: { type: string }
 *       - in: query
 *         name: with_related
 *         description: >-
 *           When set (`with_related=1`), every row gains a `RelatedIndustries` array —
 *           the curated SEO cross-links for that industry, in the editor's order.
 *           Combinable with `tree` / `hierarchy` / `parent`. Only ACTIVE industries
 *           appear in the block. Omitted by default to keep the list lean.
 *         schema: { type: string }
 *       - in: query
 *         name: q
 *         description: >-
 *           Substring match on the industry name — what the signup picker's search box
 *           sends. Combinable with `parent` to search within one industry's
 *           specializations. Ignored by `tree` / `hierarchy`, where filtering out parents
 *           would strip the matches of their context, so a search always returns a flat list.
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of industries — nested (each with `children`) when `tree` is set, otherwise flat
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BusinessCategoryListResponse' } } }
 * /industries/{ref}:
 *   get:
 *     summary: Get one industry with its related industries (SEO landing page)
 *     description: >-
 *       Single-industry fetch for an SEO landing page. `ref` accepts the slug
 *       (e.g. `restaurant-food`), a uid, or a legacy numeric id. Always carries
 *       `RelatedIndustries` — the curated, editor-ordered cross-link block — which
 *       lists only ACTIVE industries. Inactive industries are not addressable here.
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - { in: path, name: ref, required: true, schema: { type: string }, description: "Industry slug, uid, or legacy numeric id" }
 *     responses:
 *       200: { description: "The industry, with a `RelatedIndustries` array (empty when none are curated)" }
 *       404: { description: Unknown or inactive industry }
 * /business-categories:
 *   get:
 *     deprecated: true
 *     summary: "[Deprecated] List active business categories — use GET /industries"
 *     description: Backward-compatible alias of `GET /industries`. New clients should call `/industries`.
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: tree
 *         description: "As on `/industries` — full hierarchy nested parent→child."
 *         schema: { type: string }
 *       - in: query
 *         name: hierarchy
 *         description: "As on `/industries` — only top-level rows, flat."
 *         schema: { type: string }
 *       - in: query
 *         name: parent
 *         description: "Filter by parent — slug, uid, or numeric id ('null' for top-level)."
 *         schema: { type: string }
 *       - in: query
 *         name: parent_id
 *         deprecated: true
 *         description: "Legacy numeric-id form of `parent`."
 *         schema: { type: string }
 *       - in: query
 *         name: with_related
 *         description: "As on `/industries` — attaches each row's `RelatedIndustries` block."
 *         schema: { type: string }
 *       - in: query
 *         name: q
 *         description: "As on `/industries` — substring match on the name."
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of business categories
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BusinessCategoryListResponse' } } }
 */
// `q` (name search) is documented as a query param on /industries above — a path key
// carrying a query string renders as a phantom second endpoint in Swagger UI.
router.get('/industries', controller.businessCategories);
router.get('/business-categories', controller.businessCategories);
// Detail is a new endpoint, so it exists only under the current `/industries` name —
// there are no pre-rename clients to keep a `/business-categories/:ref` alias for.
router.get('/industries/:ref', controller.industryDetail);

/**
 * @swagger
 * /industries/{ref}/keywords:
 *   get:
 *     summary: Keyword suggestions for an industry (the signup "My Keywords" picker)
 *     description: >-
 *       The curated keywords for this industry. A sub-industry ALSO inherits its parent's
 *       keywords — merged and de-duped, the sub-industry's own first — so a bakery's picker
 *       offers the bakery keywords ahead of the generic food ones. `ref` is a slug, a uid,
 *       or a numeric id. These are the values `POST /businesses` and
 *       `PUT /businesses/{uid}/keywords` accept.
 *     tags: [Catalog]
 *     security: []
 *     parameters: [{ in: path, name: ref, required: true, schema: { type: string } }]
 *     responses:
 *       200:
 *         description: Array of keywords ({ id, name, slug })
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TagListResponse' } } }
 *       404:
 *         description: Industry not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/industries/:ref/keywords', controller.industryKeywords);

/**
 * @swagger
 * /template-categories:
 *   get:
 *     summary: List active template categories
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: homepage
 *         description: When set, only categories flagged show_in_homepage
 *         schema: { type: string }
 *       - in: query
 *         name: parent
 *         description: >-
 *           Filter by parent category — accepts a slug, a uid, or a numeric id.
 *           Use `null` for top-level categories. Combinable with `homepage`.
 *           Ignored when `tree` is set.
 *         schema: { type: string }
 *       - in: query
 *         name: parent_id
 *         deprecated: true
 *         description: "Legacy numeric-id form of `parent` (still accepted; prefer `parent`)."
 *         schema: { type: string }
 *       - in: query
 *         name: tree
 *         description: >-
 *           When set (any value), returns the full active hierarchy nested
 *           parent→child instead of a flat list. Each node carries a `children`
 *           array (recursive, any depth); every level is ordered by
 *           display_order ASC. The flat `parent`/`parent_id` filter is ignored
 *           in this mode.
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of template categories
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TemplateCategoryListResponse' } } }
 */
router.get('/template-categories', controller.templateCategories);

/**
 * @swagger
 * /asset-categories:
 *   get:
 *     summary: List active asset categories
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: parent
 *         description: >-
 *           Filter by parent — accepts a slug, a uid, or a numeric id.
 *           Use `null` for top-level categories.
 *         schema: { type: string }
 *       - in: query
 *         name: parent_id
 *         deprecated: true
 *         description: "Legacy numeric-id form of `parent` (still accepted; prefer `parent`)."
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of asset categories
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AssetCategoryListResponse' } } }
 */
router.get('/asset-categories', controller.assetCategories);

/**
 * @swagger
 * /tags:
 *   get:
 *     summary: List tags
 *     tags: [Catalog]
 *     security: []
 *     responses:
 *       200:
 *         description: Array of tags
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TagListResponse' } } }
 */
router.get('/tags', controller.tags);

/**
 * @swagger
 * /languages:
 *   get:
 *     summary: Available content languages (the "Preferred Languages" picker)
 *     description: >-
 *       Active languages, in display order. These select which TEMPLATES a user is shown —
 *       they are not the app's UI language. Render `native_name` ("தமிழ்"), which is what a
 *       speaker scans for; `name` is the English label for admin screens. Save a user's
 *       picks with `PATCH /users/me/preferences`.
 *     tags: [Catalog]
 *     security: []
 *     responses:
 *       200:
 *         description: Array of languages ({ id, uid, code, name, native_name, display_order })
 *         content: { application/json: { schema: { $ref: '#/components/schemas/LanguageListResponse' } } }
 */
router.get('/languages', controller.languages);

/**
 * @swagger
 * /template-sizes:
 *   get:
 *     summary: List active template sizes (canvas presets)
 *     tags: [Catalog]
 *     security: []
 *     responses:
 *       200:
 *         description: Array of template sizes
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TemplateSizeListResponse' } } }
 */
router.get('/template-sizes', controller.templateSizes);

/**
 * @swagger
 * /brand-series:
 *   get:
 *     summary: List active brand series with a preview of their variants
 *     description: >-
 *       Each series carries its style personalities, tags and colour palette, the counts the
 *       card renders (`variants_count`, `templates_count`), and a preview slice of its variants.
 *       `is_locked` is a ROLLUP of its variants, not a gate of its own: gating lives on the
 *       variant, so a series reads as locked only when every one of its variants is locked.
 *       `unlocked_variants_count` distinguishes "Unlock" from a partially-owned series.
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: preview_variants
 *         description: "How many variants to nest per series (default 4; 0 returns none)."
 *         schema: { type: integer, default: 4 }
 *     responses:
 *       200:
 *         description: Array of brand series (preview variants nested)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BrandSeriesListResponse' } } }
 */
router.get('/brand-series', controller.brandSeries);

/**
 * @swagger
 * /variants:
 *   get:
 *     summary: List active variants
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: series
 *         description: "Filter by brand series - accepts a slug, a uid, or a numeric id."
 *         schema: { type: string }
 *       - in: query
 *         name: series_id
 *         deprecated: true
 *         description: "Legacy numeric-id form of `series` (still accepted; prefer `series`)."
 *         schema: { type: integer }
 *       - in: query
 *         name: group
 *         deprecated: true
 *         description: "Pre-rename name for `series` (still accepted)."
 *         schema: { type: string }
 *       - in: query
 *         name: group_id
 *         deprecated: true
 *         description: "Pre-rename name for `series_id` (still accepted)."
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Array of variants, each with `templates_count` and `is_locked`
 *         content: { application/json: { schema: { $ref: '#/components/schemas/VariantListResponse' } } }
 */
router.get('/variants', controller.variants);

/**
 * @swagger
 * /variants/{uid}:
 *   get:
 *     summary: Get a variant with its templates (locked ones included as upsell teasers)
 *     description: >-
 *       The variant card (name, description, thumbnail, badge, industries, likes_count) is public,
 *       and so is the TEMPLATE LIST: templates are always returned so a visitor can see what they
 *       would be buying. When the caller is not entitled the response carries `is_locked=true` and
 *       every template is returned WITHOUT its `content` (the design payload) - thumbnails only.
 *       Access requires the caller's ACTIVE subscription plan to entitle the variant, or one of
 *       their businesses to have adopted it. A variant with no plan restrictions is locked to
 *       everyone, and guests are always locked. Opening a template or starting a project from one
 *       is still refused outright while locked.
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Variant object (with `is_locked`; `Templates` always present, stripped when locked)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/VariantResponse' } } }
 *       404:
 *         description: Variant not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/variants/:uid', controller.variantDetail);

// ---- Deprecated aliases (Theme -> Brand Series / Variant rename) ----
// Same handlers, annotated with RFC 8594 Deprecation/Link headers. Kept so the app and
// admin panel can migrate on their own schedule. Documented as `deprecated: true` so
// Swagger UI strikes them through and names the successor — nobody should start here.
/**
 * @swagger
 * /theme-groups:
 *   get:
 *     summary: "[Deprecated] Pre-rename alias of /brand-series"
 *     deprecated: true
 *     description: >-
 *       Identical to `GET /brand-series` — same handler, same response. Kept only so
 *       clients written before the Theme → Brand Series rename keep working. Responses
 *       carry `Deprecation: true` and `Link: </api/v1/brand-series>; rel="successor-version"`.
 *       **Use `/brand-series`**; this path will be withdrawn once the app and admin panel
 *       have migrated.
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - { in: query, name: preview_variants, schema: { type: integer }, description: "As on /brand-series" }
 *     responses:
 *       200:
 *         description: Array of brand series (preview variants nested)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BrandSeriesListResponse' } } }
 * /themes:
 *   get:
 *     summary: "[Deprecated] Pre-rename alias of /variants"
 *     deprecated: true
 *     description: >-
 *       Identical to `GET /variants`. The pre-rename `group` / `group_id` filters are still
 *       accepted here (and on `/variants`). Responses carry `Deprecation: true` and a
 *       `Link` header naming `/api/v1/variants` as the successor. **Use `/variants`.**
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - { in: query, name: series,    schema: { type: string },  description: "Brand series — slug, uid, or numeric id" }
 *       - { in: query, name: series_id, schema: { type: integer }, deprecated: true }
 *       - { in: query, name: group,     schema: { type: string },  deprecated: true, description: "Pre-rename name for `series`" }
 *       - { in: query, name: group_id,  schema: { type: integer }, deprecated: true, description: "Pre-rename name for `series_id`" }
 *     responses:
 *       200:
 *         description: Array of variants, each with `templates_count` and `is_locked`
 *         content: { application/json: { schema: { $ref: '#/components/schemas/VariantListResponse' } } }
 * /themes/{uid}:
 *   get:
 *     summary: "[Deprecated] Pre-rename alias of /variants/{uid}"
 *     deprecated: true
 *     description: >-
 *       Identical to `GET /variants/{uid}`, including the gating: the card and template list
 *       are public, but a caller who is not entitled gets `is_locked=true` and templates
 *       stripped of their `content`. **Use `/variants/{uid}`.**
 *     tags: [Catalog]
 *     security: []
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Variant object (with `is_locked`; `Templates` always present, stripped when locked)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/VariantResponse' } } }
 *       404:
 *         description: Variant not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/theme-groups', deprecated('/api/v1/brand-series'), controller.brandSeries);
router.get('/themes',       deprecated('/api/v1/variants'),     controller.variants);
router.get('/themes/:uid',  deprecated('/api/v1/variants'),     controller.variantDetail);

/**
 * @swagger
 * /faq-categories:
 *   get:
 *     summary: List active FAQ categories with their FAQs
 *     tags: [Catalog]
 *     security: []
 *     responses:
 *       200:
 *         description: Array of FAQ categories (faqs nested)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/FaqCategoryListResponse' } } }
 */
router.get('/faq-categories', controller.faqCategories);

/**
 * @swagger
 * /faqs:
 *   get:
 *     summary: List active FAQs grouped by category
 *     description: >-
 *       Active FAQs grouped under their category — categories ordered by display_order,
 *       FAQs within each by display_order. Optional category narrows to one group.
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: category
 *         description: >-
 *           Narrow to a single FAQ category — accepts a slug, a uid, or a numeric id
 *           (`null` narrows to the uncategorized group).
 *         schema: { type: string }
 *       - in: query
 *         name: category_id
 *         deprecated: true
 *         description: "Legacy numeric-id form of `category` (still accepted; prefer `category`)."
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Array of FAQ categories (faqs nested)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/FaqCategoryListResponse' } } }
 */
router.get('/faqs', controller.faqs);

/**
 * @swagger
 * /testimonials:
 *   get:
 *     summary: List active testimonials
 *     tags: [Catalog]
 *     security: []
 *     responses:
 *       200:
 *         description: Array of testimonials
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TestimonialListResponse' } } }
 */
router.get('/testimonials', controller.testimonials);

/**
 * @swagger
 * /banners:
 *   get:
 *     summary: List active, in-window app banners (audience-targeted by tier)
 *     tags: [Catalog]
 *     security: []
 *     responses:
 *       200:
 *         description: Array of banners
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AppBannerListResponse' } } }
 */
router.get('/banners', controller.banners);

/**
 * @swagger
 * /special-events:
 *   get:
 *     summary: List special events occurring in a date window, with their templates
 *     description: >-
 *       Returns active events that fall within the window — recurring events matched on month-day
 *       (so a Dec→Jan window correctly surfaces Christmas and New Year), one-offs on full_date.
 *       Each event includes an `occurs_on` concrete date (for per-day grouping) and its active
 *       `Templates` (premium ones marked `is_locked`, content withheld). The window is `meta.range`.
 *       Default window is this week (rolling 7 days); use `range=month` or explicit `from`/`to`.
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - { in: query, name: from,  schema: { type: string, format: date }, description: Window start (YYYY-MM-DD) }
 *       - { in: query, name: to,    schema: { type: string, format: date }, description: Window end (YYYY-MM-DD) }
 *       - { in: query, name: range, schema: { type: string, enum: [week, month] }, description: Shortcut when from/to omitted (default week) }
 *     responses:
 *       200:
 *         description: Events in the window (each with occurs_on + Templates); meta.range echoes the window
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SpecialEventListResponse' } } }
 *       400:
 *         description: Invalid from/to
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/special-events', controller.specialEvents);

/**
 * @swagger
 * /plans:
 *   get:
 *     summary: List active plans (public pricing)
 *     description: >-
 *       Active plans ordered by display_order, each with active billing options, trial_days,
 *       a `coupons` array (active+valid coupons applicable to the plan), and a `features` array
 *       for the pricing card. Each feature is pre-rendered: `display_label` is never null (the
 *       admin override when set, otherwise derived — "500 AI BG remover credits",
 *       "Unlimited downloads", or the plain label for booleans) and `enabled` is false when the
 *       plan does not include it, which is the greyed-out row on the card. Features are ordered
 *       by display_order. Subject to the public tiered rate limit.
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: plan_type
 *         schema: { type: string, enum: [subscription, access_pass], default: subscription }
 *         description: Defaults to subscription. Use access_pass to fetch the one-time ₹10 pass.
 *       - in: query
 *         name: billing_option_type
 *         schema: { type: string, enum: [monthly, annual] }
 *         description: Restrict embedded billing options (and qualifying plans) to this cycle.
 *     responses:
 *       200:
 *         description: Array of plans
 *         content: { application/json: { schema: { $ref: '#/components/schemas/PlanListResponse' } } }
 */
router.get('/plans', controller.plans);

module.exports = router;
