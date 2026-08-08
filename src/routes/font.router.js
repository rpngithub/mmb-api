const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/font.controller');
const authenticate = require('../middlewares/authenticate');
const optionalAuth = require('../middlewares/optionalAuth');
const rateLimiter  = require('../middlewares/rateLimiter');
const validate     = require('../middlewares/validate');
const { createOwnFontSchema } = require('../validators/font.validator');

/**
 * @swagger
 * tags:
 *   - name: Fonts
 *     description: Brand Kit typography — the curated library plus the user's own uploads
 */

/**
 * @swagger
 * /fonts:
 *   get:
 *     summary: Fonts available to me
 *     description: >-
 *       The curated library plus any fonts you uploaded yourself — one list, with `is_own`
 *       marking which are yours. Each carries its files (`FontFiles`: weight, style, format,
 *       s3_key) and its script coverage (`Languages`).
 *
 *
 *       `is_locked` marks a premium library font your plan doesn't include; its files are
 *       withheld until you upgrade, though it still appears so you can see what you'd get.
 *
 *
 *       `?language=ta` narrows to fonts that can actually render that script. Fonts with no
 *       declared coverage are always included — unclassified means unknown, not incapable.
 *     tags: [Fonts]
 *     security: []
 *     parameters:
 *       - { in: query, name: language, schema: { type: string }, description: "Language code, e.g. 'ta'" }
 *     responses:
 *       200:
 *         description: The library plus the caller's own fonts
 *         content: { application/json: { schema: { $ref: '#/components/schemas/FontListResponse' } } }
 *   post:
 *     summary: Register a font I uploaded
 *     description: >-
 *       Turns a file uploaded to the `brand_font` slot into a font family you can select in
 *       the Brand Kit. Upload each file first via `/uploads/presign` + `/uploads/confirm`,
 *       then send the keys here. A key you did not upload to that slot is rejected.
 *     tags: [Fonts]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [family, files]
 *             properties:
 *               family: { type: string, example: 'Acme Sans' }
 *               files:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [s3_key, format]
 *                   properties:
 *                     s3_key: { type: string, description: "A key from /uploads/presign with slot `brand_font`, already confirmed" }
 *                     format: { type: string, enum: [woff2, woff, ttf, otf] }
 *                     weight: { type: integer, minimum: 100, maximum: 900, default: 400 }
 *                     style:  { type: string, enum: [normal, italic], default: normal }
 *     responses:
 *       201:
 *         description: The created font, with its files
 *         content: { application/json: { schema: { $ref: '#/components/schemas/FontResponse' } } }
 *       400:
 *         description: A file key was not issued to you for the brand_font slot
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       409:
 *         description: You already have a font with this name
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 * /fonts/{uid}:
 *   delete:
 *     summary: Delete a font I uploaded
 *     description: >-
 *       Removes the family and its files, refunding the storage. A business using it falls
 *       back to the default typeface rather than breaking. Library fonts cannot be deleted.
 *     tags: [Fonts]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Deleted; storage refunded
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 *       403:
 *         description: Not your font (library fonts cannot be deleted)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       404:
 *         description: Not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/', optionalAuth, rateLimiter.publicTiered, controller.list);
router.post('/', authenticate, validate(createOwnFontSchema), controller.createOwn);
router.delete('/:uid', authenticate, controller.removeOwn);

module.exports = router;
