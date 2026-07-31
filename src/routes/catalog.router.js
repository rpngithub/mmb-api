const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/catalog.controller');
const optionalAuth = require('../middlewares/optionalAuth');
const rateLimiter  = require('../middlewares/rateLimiter');

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
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: parent
 *         description: >-
 *           Filter by parent industry — accepts a slug (e.g. `restaurant-food`),
 *           a uid, or a numeric id. Use `null` for top-level industries.
 *         schema: { type: string }
 *       - in: query
 *         name: parent_id
 *         deprecated: true
 *         description: "Legacy numeric-id form of `parent` (still accepted; prefer `parent`)."
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of industries
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BusinessCategoryListResponse' } } }
 * /business-categories:
 *   get:
 *     deprecated: true
 *     summary: "[Deprecated] List active business categories — use GET /industries"
 *     description: Backward-compatible alias of `GET /industries`. New clients should call `/industries`.
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: parent
 *         description: "Filter by parent — slug, uid, or numeric id ('null' for top-level)."
 *         schema: { type: string }
 *       - in: query
 *         name: parent_id
 *         deprecated: true
 *         description: "Legacy numeric-id form of `parent`."
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of business categories
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BusinessCategoryListResponse' } } }
 */
router.get('/industries', controller.businessCategories);
router.get('/business-categories', controller.businessCategories);

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
 * /theme-groups:
 *   get:
 *     summary: List active theme groups with their themes
 *     tags: [Catalog]
 *     security: []
 *     responses:
 *       200:
 *         description: Array of theme groups (themes nested)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ThemeGroupListResponse' } } }
 */
router.get('/theme-groups', controller.themeGroups);

/**
 * @swagger
 * /themes:
 *   get:
 *     summary: List active themes
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: group
 *         description: "Filter by theme group — accepts a slug, a uid, or a numeric id."
 *         schema: { type: string }
 *       - in: query
 *         name: group_id
 *         deprecated: true
 *         description: "Legacy numeric-id form of `group` (still accepted; prefer `group`)."
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Array of themes
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ThemeListResponse' } } }
 */
router.get('/themes', controller.themes);

/**
 * @swagger
 * /themes/{uid}:
 *   get:
 *     summary: Get a theme with its (plan-gated) templates
 *     description: >-
 *       The theme card (name, description, thumbnail, business categories, likes_count) is public.
 *       Its templates are premium and plan-gated: they are included ONLY when the caller's ACTIVE
 *       subscription plan is entitled to the theme. Otherwise the response has `is_locked=true` and
 *       no `Templates` (an upsell teaser). A theme with no plan restrictions is locked to everyone.
 *       A bearer token is required to be entitled (guests are always locked).
 *     tags: [Catalog]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Theme object (with `is_locked`; `Templates` present only when entitled)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ThemeResponse' } } }
 *       404:
 *         description: Theme not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/themes/:uid', controller.themeDetail);

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
 *       Active plans ordered by display_order, each with active billing options, card-visible
 *       features, trial_days, and a `coupons` array (active+valid coupons applicable to the plan).
 *       Subject to the public tiered rate limit.
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
