const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/template.controller');
const optionalAuth = require('../middlewares/optionalAuth');
const rateLimiter  = require('../middlewares/rateLimiter');

/**
 * @swagger
 * tags:
 *   - name: Templates
 *     description: >-
 *       Template discovery (public; premium templates are locked for non-paid viewers).
 *       A design is a template FAMILY with one version per language × size. Lists return
 *       ONE card per design, showing the version picked for the viewer; the card's `uid`
 *       is that version's, and `family_uid` names the design.
 */

/**
 * @swagger
 * /templates:
 *   get:
 *     summary: List active designs, one card each (public)
 *     description: >-
 *       No JWT required. A bearer token raises the rate-limit tier and clears `is_locked` for paid users.
 *       One card per design (template family). A design appears only if it has an active
 *       version in one of the viewer's languages — `language` if given (its order is the
 *       ranking), else the signed-in user's Preferred Languages in their ranked order, else
 *       English — or a text-free version (shown to everyone); and, with `size`, only if it
 *       has that size. The card shows the version in the highest-ranked language, then the
 *       default size (`default_template_size` in GET /config), then the lowest size id.
 *       Language beats size. `all_languages=1` switches the language rule off (SEO pages).
 *       Premium templates return `is_locked=true` for guests/free users (cards never carry `content`).
 *       The browse view must be anchored: at least one of `category`, `industry` or `q`
 *       is required (the full catalog is never returned). Other params only narrow the result.
 *       **Search (`q`)**: every word must match the design somewhere — its name, its admin
 *       `search_keywords`, a tag, its category (or that category's parent), an industry (or its
 *       parent), a special event, its `template_type`, or an active version's size (name/slug, or
 *       platform as a whole word) or language (code, English or native name, as a whole word).
 *       Matching is a case-insensitive substring; `%` and `_` are literal. A word naming a
 *       language ("tamil", "ta", "தமிழ்") also moves that language to the front of the viewer's
 *       rank, so designs in it show and their cards use that version — unless `language` or
 *       `all_languages` is sent. With `q`, results are ordered by relevance (name starts with
 *       the query, then name contains it, then every word is in the name/keywords/tags, then the
 *       rest), then `trending_score`.
 *       All taxonomy filters accept a friendly slug (e.g. `youtube-thumbnails`), a uid, or a
 *       legacy numeric id — a supplied filter that resolves to nothing returns an empty page.
 *       Note: theme templates are NOT browsable here — they are premium and plan-gated,
 *       served only via `GET /themes/{uid}`.
 *     tags: [Templates]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: q
 *         description: >-
 *           Plain-text search, 2–100 characters (shorter is ignored, so it does not anchor;
 *           longer is a 400). Up to 8 words; one-letter words are dropped when longer ones are present.
 *         schema: { type: string, minLength: 2, maxLength: 100 }
 *         example: diwali offer
 *       - in: query
 *         name: category
 *         description: Template category — slug (e.g. `youtube-thumbnails`), uid, or numeric id.
 *         schema: { type: string }
 *       - in: query
 *         name: industry
 *         description: Industry (business category) — slug (e.g. `restaurant-food`), uid, or numeric id.
 *         schema: { type: string }
 *       - in: query
 *         name: business_category
 *         deprecated: true
 *         description: "Former name for `industry` (still accepted; prefer `industry`)."
 *         schema: { type: string }
 *       - in: query
 *         name: size
 *         description: Post size (template size) — slug, uid, or numeric id. Hides designs without a version in this size.
 *         schema: { type: string }
 *       - in: query
 *         name: language
 *         description: "Comma-separated language codes in rank order (e.g. `ta,en`); overrides the saved Preferred Languages."
 *         schema: { type: string }
 *       - in: query
 *         name: all_languages
 *         description: "Any value: do not narrow by language (the card still prefers English)."
 *         schema: { type: integer, enum: [1] }
 *       - in: query
 *         name: tags
 *         description: >-
 *           Comma-separated tags — each a slug, uid, or numeric id; matches templates
 *           carrying ANY of them (e.g. `sale,festival` or `12,34,56`).
 *         schema: { type: string }
 *       - in: query
 *         name: category_id
 *         deprecated: true
 *         description: "Legacy numeric-id form of `category` (still accepted)."
 *         schema: { type: integer }
 *       - in: query
 *         name: business_category_id
 *         deprecated: true
 *         description: "Legacy numeric-id form of `industry` (still accepted)."
 *         schema: { type: integer }
 *       - in: query
 *         name: size_id
 *         deprecated: true
 *         description: "Legacy numeric-id form of `size` (still accepted)."
 *         schema: { type: integer }
 *       - in: query
 *         name: template_type
 *         schema: { type: string, enum: [image, video, animated] }
 *       - in: query
 *         name: is_premium
 *         description: "1 = premium only, 0 = free only; omit for both."
 *         schema: { type: integer, enum: [0, 1] }
 *       - in: query
 *         name: is_popular
 *         description: "1 = only templates admins have flagged Popular, 0 = only the rest; omit for both."
 *         schema: { type: integer, enum: [0, 1] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 30, maximum: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: >-
 *           Array of design cards (each with `is_locked`; `content` excluded). Each card keeps the
 *           template fields (`id`/`uid`/`thumbnail_s3_key`/`language_id`/`size_id` are the picked
 *           VERSION's; name, category, access and counters are the design's) plus `family_uid`,
 *           `Language`, `TemplateSize`, `available_languages` and `available_sizes`.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/TemplatePublicListResponse' }
 *       400:
 *         description: No anchor filter supplied (need category, industry or q), or q longer than 100 characters
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.get('/', optionalAuth, rateLimiter.publicTiered, controller.list);

/**
 * @swagger
 * /templates/suggestions:
 *   get:
 *     summary: Autocomplete for the template search box (public)
 *     description: >-
 *       No JWT required (a bearer token applies the user's Preferred Languages and rate-limit tier).
 *       Short mixed suggestions — special events, template categories, industries, tags and design
 *       names — whose label, or any word in it, STARTS with `q` (case-insensitive; `%`/`_` literal).
 *       Each is `{ type, label, query }`: show `label`, and on tap send `query` to
 *       `GET /templates?q=` (it is the label, cut at a word boundary if longer than 100 chars).
 *       A design is also suggested, by its name, when `q` starts one of its admin
 *       `search_keywords` (or a word in one) — keywords themselves are never shown; such a
 *       hit ranks as a word prefix.
 *       Only things that would return results are suggested: a design only if it is live and
 *       visible to this viewer (not Brand Series, a version in their languages — `language` /
 *       `all_languages` work as on GET /templates), and a category / industry / tag / event only
 *       if such a design sits under it (a parent counts its children's) and it is active.
 *       Order: whole-label prefix before word prefix, then events, categories, industries, tags,
 *       designs; then popularity. At most 3 of each non-design type; labels are de-duplicated
 *       case-insensitively. A blank `q` returns `[]` (not a 400).
 *     tags: [Templates]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         description: What the user has typed so far — 1 to 100 characters.
 *         schema: { type: string, maxLength: 100 }
 *         example: diw
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 8, maximum: 20 }
 *       - in: query
 *         name: language
 *         description: "As on GET /templates — comma-separated language codes in rank order."
 *         schema: { type: string }
 *       - in: query
 *         name: all_languages
 *         description: "As on GET /templates — any value: do not narrow by language."
 *         schema: { type: integer, enum: [1] }
 *     responses:
 *       200:
 *         description: Suggestions, best first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       type:  { type: string, enum: [event, category, industry, tag, design] }
 *                       label: { type: string, example: Diwali }
 *                       query: { type: string, example: Diwali, description: "Send as GET /templates?q=" }
 *       400:
 *         description: q longer than 100 characters
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.get('/suggestions', optionalAuth, rateLimiter.publicTiered, controller.suggestions);

/**
 * @swagger
 * /templates/families/{uid}:
 *   get:
 *     summary: Open a design by its family uid (share / deep links)
 *     description: >-
 *       Picks the version for the viewer exactly as a feed card would (language rank, then the
 *       default size) and returns the same shape as `GET /templates/{uid}`. A link is never
 *       hidden for language: a design with no version in the viewer's languages opens in its
 *       best one (English first). Counts one view.
 *     tags: [Templates]
 *     security: []
 *     parameters:
 *       - { in: path, name: uid, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: "The picked version, as GET /templates/{uid}" }
 *       404: { description: Design not found or not active, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 */
router.get('/families/:uid', optionalAuth, rateLimiter.publicTiered, controller.getFamily);

/**
 * @swagger
 * /templates/{uid}:
 *   get:
 *     summary: Open one version of a design by its uid (public)
 *     description: >-
 *       `content` is always returned so the editor can open any design. Premium designs carry
 *       `is_locked=true` unless the caller is a paid user — the client lets them edit freely and
 *       asks for a subscription or the ₹10 access pass when they export or share. Besides the template fields, the response carries `family` and `versions`
 *       — every active language × size of the design (not filtered by Preferred Languages) —
 *       for the editor's language/size switcher. Switching opens another version's uid with
 *       `switch=1`, which is served the same but not counted as another view. Every uid ever
 *       issued for a template still works: each is now a version.
 *     tags: [Templates]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: switch
 *         description: "1 = switching versions inside the editor; do not count a view."
 *         schema: { type: integer, enum: [1] }
 *     responses:
 *       200:
 *         description: Template version object with `family` and `versions`
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/TemplatePublicResponse' }
 *       404:
 *         description: Template not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.get('/:uid', optionalAuth, rateLimiter.publicTiered, controller.getOne);

module.exports = router;
