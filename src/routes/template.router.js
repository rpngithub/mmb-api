const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/template.controller');
const optionalAuth = require('../middlewares/optionalAuth');
const rateLimiter  = require('../middlewares/rateLimiter');

/**
 * @swagger
 * tags:
 *   - name: Templates
 *     description: Template discovery (public; premium templates are locked for non-paid viewers)
 */

/**
 * @swagger
 * /templates:
 *   get:
 *     summary: List active templates (public)
 *     description: >-
 *       No JWT required. A bearer token raises the rate-limit tier and unlocks premium content.
 *       Premium templates return `is_locked=true` and omit `content` for guests/free users.
 *       The browse view must be anchored: at least one of `category` or `industry`
 *       is required (the full catalog is never returned). Other params only narrow the result.
 *       All taxonomy filters accept a friendly slug (e.g. `youtube-thumbnails`), a uid, or a
 *       legacy numeric id — a supplied filter that resolves to nothing returns an empty page.
 *       Note: theme templates are NOT browsable here — they are premium and plan-gated,
 *       served only via `GET /themes/{uid}`.
 *     tags: [Templates]
 *     security: []
 *     parameters:
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
 *         description: Post size (template size) — slug, uid, or numeric id.
 *         schema: { type: string }
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
 *         name: limit
 *         schema: { type: integer, default: 30, maximum: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Array of templates (each with `is_locked`; `content` excluded from list responses)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/TemplatePublicListResponse' }
 *       400:
 *         description: No anchor filter supplied (need category or industry)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.get('/', optionalAuth, rateLimiter.publicTiered, controller.list);

/**
 * @swagger
 * /templates/{uid}:
 *   get:
 *     summary: Get a template by uid (public)
 *     description: Premium templates return `is_locked=true` with `content` withheld unless the caller is a paid user.
 *     tags: [Templates]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Template object
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
