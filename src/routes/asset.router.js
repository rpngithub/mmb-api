const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/asset.controller');
const optionalAuth = require('../middlewares/optionalAuth');
const rateLimiter  = require('../middlewares/rateLimiter');

/**
 * @swagger
 * tags:
 *   - name: Assets
 *     description: Asset library (public; premium assets are locked for non-paid viewers)
 */

/**
 * @swagger
 * /assets:
 *   get:
 *     summary: List active assets by category (public)
 *     description: >-
 *       No JWT required. A bearer token raises the rate-limit tier and unlocks premium assets.
 *       `category` (the anchor) is required; `tags` and `asset_type` are optional filters.
 *       `category` and each `tags` entry accept a friendly slug, a uid, or a legacy numeric id.
 *       Premium assets return `is_locked=true` and omit `s3_key` for guests/free users.
 *     tags: [Assets]
 *     security: []
 *     parameters:
 *       - { in: query, name: category, required: true, schema: { type: string }, description: "Asset category — slug, uid, or numeric id" }
 *       - { in: query, name: category_id, deprecated: true, schema: { type: integer }, description: "Legacy numeric-id form of category (still accepted)" }
 *       - { in: query, name: tags,        schema: { type: string }, description: "Comma-separated tags — each a slug, uid, or numeric id (ANY match)" }
 *       - { in: query, name: asset_type,  schema: { type: string, enum: [icon, emoji, shape, font, audio, video, animated, bg] } }
 *       - { in: query, name: limit,       schema: { type: integer, default: 50, maximum: 100 } }
 *       - { in: query, name: offset,      schema: { type: integer, default: 0 } }
 *     responses:
 *       200:
 *         description: Array of assets (each with `is_locked`; `s3_key` withheld for locked premium)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AssetListResponse' } } }
 *       400:
 *         description: Missing category
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/', optionalAuth, rateLimiter.publicTiered, controller.list);

module.exports = router;
