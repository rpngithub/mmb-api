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
 *     summary: List active assets by category and/or type (public)
 *     description: >-
 *       No JWT required. A bearer token raises the rate-limit tier and unlocks premium assets.
 *       At least one of `category` or `asset_type` is required — either anchors the browse, and
 *       they combine. An unanchored call is refused rather than listing the whole library.
 *       `tags` is an optional extra filter. `category` and each `tags` entry accept a friendly
 *       slug, a uid, or a legacy numeric id; `category=null` lists uncategorized assets.
 *       A `category` that resolves to nothing returns an empty page (a typo must not widen the
 *       results), while an unknown `asset_type` is a 400.
 *
 *
 *       Premium assets return `is_locked=true` and omit `s3_key` for guests/free users, but
 *       ALWAYS carry `thumbnail_s3_key` — a locked asset is meant to be seen and not used.
 *       Render `thumbnail_s3_key || s3_key`: a free asset normally has no separate thumbnail
 *       and falls back to its own file, while a locked one has only the thumbnail (null if an
 *       admin has not uploaded one yet — show a placeholder).
 *     tags: [Assets]
 *     security: []
 *     parameters:
 *       - { in: query, name: category,    schema: { type: string }, description: "Asset category — slug, uid, numeric id, or 'null' for uncategorized. Required unless asset_type is given" }
 *       - { in: query, name: category_id, deprecated: true, schema: { type: integer }, description: "Legacy numeric-id form of category (still accepted)" }
 *       - { in: query, name: tags,        schema: { type: string }, description: "Comma-separated tags — each a slug, uid, or numeric id (ANY match)" }
 *       - { in: query, name: asset_type,  schema: { type: string, enum: [icon, emoji, shape, audio, video, animated, bg] }, description: "Required unless category is given" }
 *       - { in: query, name: limit,       schema: { type: integer, default: 50, maximum: 100 } }
 *       - { in: query, name: offset,      schema: { type: integer, default: 0 } }
 *     responses:
 *       200:
 *         description: Array of assets (each with `is_locked` and `thumbnail_s3_key`; `s3_key` withheld for locked premium)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AssetListResponse' } } }
 *       400:
 *         description: Neither category nor asset_type supplied, or asset_type is not a known type
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/', optionalAuth, rateLimiter.publicTiered, controller.list);

module.exports = router;
