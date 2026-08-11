const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/userUpload.controller');
const authenticate = require('../middlewares/authenticate');
const validate     = require('../middlewares/validate');
const { presignSchema, confirmSchema } = require('../validators/userUpload.validator');

/**
 * @swagger
 * tags:
 *   - name: Uploads
 *     description: |
 *       Direct-to-S3 uploads for the signed-in user (logo, cover, profile photo,
 *       product images, frames, the editor's media library, and Brand Kit font
 *       files). Three steps:
 *
 *       1. `POST /uploads/presign` — returns the final `key` and a short-lived `upload_url`.
 *       2. `PUT` the file to `upload_url`, echoing every header in `required_headers`.
 *       3. `POST /uploads/confirm` — promotes the object from pending to active.
 *
 *       **Bulk uploads** use the same three steps. Send `files: [...]` to presign
 *       (up to 20) to get all the URLs in one call, `PUT` them in parallel — keep
 *       concurrency to about 4–6, browsers queue past that — then confirm every key
 *       in one call. Confirm reports each key separately: a batch is not
 *       all-or-nothing, so one oversized file does not discard the rest.
 *
 *       Then save `key` onto the record it belongs to (`logo_s3_key` on the business,
 *       `s3_key` on a product image or frame, `profile_photo_s3_key` on the user).
 *       Keys are always issued under `users/{your uid}/{slot}/`; saving a key from
 *       outside your own namespace, or under the wrong slot, is rejected.
 *
 *       Objects that are never confirmed stay tagged `status=pending` and are swept
 *       by the bucket lifecycle rule, so an abandoned upload costs nothing.
 */

/**
 * @swagger
 * /uploads/presign:
 *   post:
 *     summary: Get presigned URLs to upload one file, or a batch
 *     description: >-
 *       Send one file (`target` + `filename`) or up to 20 under `files`. The response
 *       mirrors whichever shape was sent: flat for a single file, a `files` array for a
 *       batch. The whole batch is validated before any URL is issued, so a bad slot in
 *       one entry fails the request outright rather than half-signing it — nothing has
 *       been uploaded at that point, and the error names the offending index.
 *     tags: [Uploads]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 title: One file
 *                 required: [target, filename]
 *                 properties:
 *                   target:
 *                     type: object
 *                     required: [slot]
 *                     properties:
 *                       slot:
 *                         type: string
 *                         enum: [profile_photo, business_logo, business_cover, product_image, user_frame, media_library, brand_font]
 *                   filename:     { type: string, description: "Used only for its extension; the stored name is a uuid." }
 *                   content_type:
 *                     type: string
 *                     description: >-
 *                       Image slots take raster images only — SVG is deliberately excluded for user
 *                       uploads, since it can carry script and these files are served back to
 *                       browsers. The `brand_font` slot takes font types instead, and because
 *                       browsers report those inconsistently (the same .woff2 arrives as font/woff2,
 *                       application/font-woff2 or application/octet-stream) the FILE EXTENSION is
 *                       checked as well — .woff2, .woff, .ttf or .otf.
 *                     enum:
 *                       ['image/jpeg', 'image/png', 'image/webp', 'image/gif',
 *                        'font/woff2', 'font/woff', 'font/ttf', 'font/otf', 'font/sfnt',
 *                        'application/font-woff', 'application/font-woff2', 'application/x-font-ttf',
 *                        'application/x-font-otf', 'application/octet-stream']
 *               - type: object
 *                 title: Batch
 *                 required: [files]
 *                 properties:
 *                   files:
 *                     type: array
 *                     minItems: 1
 *                     maxItems: 20
 *                     description: >-
 *                       Same fields per entry as the single form. Slots may be mixed in one
 *                       batch. The cap matches confirm's, so everything presigned together
 *                       can be confirmed together.
 *                     items:
 *                       type: object
 *                       required: [target, filename]
 *                       properties:
 *                         target:
 *                           type: object
 *                           required: [slot]
 *                           properties:
 *                             slot:
 *                               type: string
 *                               enum: [profile_photo, business_logo, business_cover, product_image, user_frame, media_library, brand_font]
 *                         filename:     { type: string }
 *                         content_type: { type: string }
 *     responses:
 *       200:
 *         description: The key(s) to upload to, and where to PUT them
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - $ref: '#/components/schemas/PresignResponse'
 *                 - $ref: '#/components/schemas/BatchPresignResponse'
 *       400:
 *         description: Unknown slot, disallowed content type, (font slot) a bad extension, or more than 20 files
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       402:
 *         description: >-
 *           Storage allowance already full — refused up front so the client does not waste a
 *           round trip uploading into a full account.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/presign', authenticate, validate(presignSchema), controller.presign);

/**
 * @swagger
 * /uploads/confirm:
 *   post:
 *     summary: Promote uploaded objects from pending to active
 *     description: >-
 *       Call after the `PUT`s succeed — once for the whole batch, up to 20 keys. Rejects
 *       any key outside your own namespace, any key with no object behind it, and any
 *       file over the size limit (which is deleted rather than promoted — a presigned PUT
 *       cannot carry a size condition, so this is the only point it can be enforced).
 *
 *
 *       Outcomes are reported PER KEY in `results`, and the good files in a batch are
 *       promoted even if others are rejected: read `results`, not just the status code.
 *       `keys` lists the confirmed ones only. If every key fails, the request fails with
 *       the first error instead (400, or 402 when storage ran out), so a single-key
 *       confirm is unchanged from before.
 *     tags: [Uploads]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [keys]
 *             properties:
 *               keys:
 *                 type: array
 *                 items: { type: string }
 *                 maxItems: 20
 *                 description: "Simple form — just the keys."
 *               uploads:
 *                 type: array
 *                 description: >-
 *                   Richer form, for media-library images. Same promotion, but records the
 *                   dimensions and original filename the grid needs — the server cannot work
 *                   those out without decoding the file. Send this OR `keys`, not both.
 *                 maxItems: 20
 *                 items:
 *                   type: object
 *                   required: [key]
 *                   properties:
 *                     key:      { type: string }
 *                     width:    { type: integer }
 *                     height:   { type: integer }
 *                     filename: { type: string, description: "The user's own filename, for the tile label" }
 *     responses:
 *       200:
 *         description: >-
 *           At least one key was promoted. `results` says which — a 200 does NOT mean every
 *           key succeeded.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ConfirmUploadResponse' } } }
 *       400:
 *         description: >-
 *           EVERY key failed — outside your namespace, missing object, or file too large.
 *           A batch with any success returns 200 instead.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       402:
 *         description: >-
 *           Storage limit reached on every key — the objects are deleted, not stored. When
 *           only some of a batch ran out of room, those come back as rejected inside a 200.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/confirm', authenticate, validate(confirmSchema), controller.confirm);

/**
 * @swagger
 * /uploads/quota:
 *   get:
 *     summary: My storage allowance
 *     description: >-
 *       The same figures presign returns, without having to start an upload to get them.
 *       Read this when sizing a bulk upload, or to render a "82 MB of 100 MB used" bar.
 *
 *
 *       **Everything is in BYTES**, so it compares directly against `File.size`.
 *       `GET /subscriptions/me` reports the same allowance in MB — that one is for
 *       rendering the plan's feature list, this one is for deciding whether a file fits.
 *
 *
 *       `limit_bytes` and `remaining_bytes` are `null` when the allowance is unlimited or
 *       unenforced (a free account); `used_bytes` is always real, so consumption can be
 *       shown either way. Check `unlimited` rather than testing for null.
 *     tags: [Uploads]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Storage allowance and per-file cap, in bytes
 *         content: { application/json: { schema: { $ref: '#/components/schemas/StorageQuotaResponse' } } }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get('/quota', authenticate, controller.quota);

/**
 * @swagger
 * /uploads:
 *   get:
 *     summary: My uploads ("Media Library")
 *     description: >-
 *       The images the user has uploaded for the editor, newest first. Defaults to the
 *       `media_library` slot — logos, covers, product images and frames are managed on their
 *       own screens and are not listed here, so nobody can delete their logo from a media grid
 *       by accident. Pass `slot` to look at another one. `s3_key` is what you prepend
 *       `cdn_base_url` to.
 *     tags: [Uploads]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: slot,   schema: { type: string, enum: [media_library, profile_photo, business_logo, business_cover, product_image, user_frame, brand_font], default: media_library } }
 *       - { in: query, name: limit,  schema: { type: integer, default: 50, maximum: 100 } }
 *       - { in: query, name: offset, schema: { type: integer, default: 0 } }
 *     responses:
 *       200:
 *         description: The caller's uploads for that slot, newest first, with meta.total
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserUploadListResponse' } } }
 */
router.get('/', authenticate, controller.list);

/**
 * @swagger
 * /uploads/{uid}:
 *   delete:
 *     summary: Delete one of my uploads
 *     description: >-
 *       Removes the file from storage and refunds its bytes against the plan quota.
 *       **Warn the user first**: a saved design that used this image will render it broken.
 *       Nothing links a project to the uploads it uses (project content is an opaque blob),
 *       so the server cannot tell them which designs are affected.
 *     tags: [Uploads]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Deleted; storage refunded
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 *       404:
 *         description: Not found (or not yours)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.delete('/:uid', authenticate, controller.remove);

module.exports = router;
