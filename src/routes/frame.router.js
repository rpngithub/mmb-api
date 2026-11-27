const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/frame.controller');
const authenticate = require('../middlewares/authenticate');
const optionalAuth = require('../middlewares/optionalAuth');
const rateLimiter  = require('../middlewares/rateLimiter');
const validate     = require('../middlewares/validate');
const { saveFrameDesignSchema } = require('../validators/frame.validator');

/**
 * @swagger
 * tags:
 *   - name: Frames
 *     description: >
 *       The frames store. Frames are admin-authored, categorised, and either free
 *       or bought outright for a per-frame price — unlike premium templates, a
 *       plan never grants them. What a user owns is "My Frames", and it survives
 *       a lapsed subscription.
 */

/**
 * @swagger
 * /frames:
 *   get:
 *     summary: Browse the frames store
 *     description: >
 *       Active frames in active categories only, ONE card per frame. A frame is a family
 *       of versions (language × size) and follows the template catalogue's rules: it is
 *       shown only with an active version in one of the viewer's languages (their saved
 *       Preferred Languages, else English) or a text-free one — and, with `size`, in that
 *       size. The card shows the version in their top language, then the default size,
 *       as `version`, with `available_languages` / `available_sizes`. Signing in is
 *       optional — a bearer token marks each card with `owned` and unlocks nothing else.
 *     tags: [Frames]
 *     parameters:
 *       - in: query
 *         name: frame_type
 *         schema: { type: string, enum: [static, animated] }
 *         description: The store's two tabs.
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *         description: "Frame category as a slug, uid, or legacy integer id. An unknown value returns an empty page, not the whole store."
 *       - in: query
 *         name: size
 *         schema: { type: string }
 *         description: "Template size slug, uid or id — only frames drawn for that poster size. An unknown value returns an empty page."
 *       - in: query
 *         name: language
 *         schema: { type: string }
 *         description: "Comma list of language codes, in rank order (e.g. `ta,en`). Overrides the viewer's saved languages."
 *       - in: query
 *         name: all_languages
 *         schema: { type: integer, enum: [1] }
 *         description: No language narrowing at all.
 *       - in: query
 *         name: is_premium
 *         schema: { type: integer, enum: [0, 1] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 30, maximum: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: "Store page. Each item carries `price`, `strike_price`, `owned` and `is_locked`; `content` is never included in a list."
 *         content: { application/json: { schema: { $ref: '#/components/schemas/FrameListResponse' } } }
 */
router.get('/', optionalAuth, rateLimiter.publicTiered, controller.list);

/**
 * @swagger
 * /frames/categories:
 *   get:
 *     summary: List frame categories (the store's filter chips)
 *     tags: [Frames]
 *     responses:
 *       200:
 *         description: Active categories in display order
 *         content: { application/json: { schema: { $ref: '#/components/schemas/FrameCategoryListResponse' } } }
 */
router.get('/categories', optionalAuth, rateLimiter.publicTiered, controller.listCategories);

/**
 * @swagger
 * /frames/mine:
 *   get:
 *     summary: List My Frames
 *     description: Frames the caller owns, newest first. Pending purchases and removed frames are not included.
 *     tags: [Frames]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Owned frames, each with its full frame record
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserFrameListResponse' } } }
 */
router.get('/mine', authenticate, controller.listMine);

/**
 * @swagger
 * /frames/mine/{uid}:
 *   delete:
 *     summary: Remove a frame from My Frames
 *     description: >
 *       Takes the frame off the shelf. A frame that was PAID for stays re-addable
 *       for free afterwards — the ownership record is kept, not deleted. There is
 *       no refund. The caller's edited copies of the frame ARE deleted — re-adding
 *       it starts from the original design — and a business wearing it as its
 *       `active_frame_id` has that cleared.
 *     tags: [Frames]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid }, description: "The FRAME uid — `Frame.uid` on a My Frames row, not the row's own `uid`" }]
 *     responses:
 *       200:
 *         description: Removed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 *       404:
 *         description: Not in My Frames
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.delete('/mine/:uid', authenticate, controller.remove);

/**
 * @swagger
 * /frames/mine/{uid}/versions/{versionUid}:
 *   put:
 *     summary: Save my edited copy of a frame version
 *     description: >
 *       Creates or replaces the caller's own copy of one version (language × size) of a
 *       frame in their My Frames. The original is never changed. From then on
 *       `GET /frames/{uid}` returns this copy as `content` for that version, with
 *       `design` describing it, and My Frames shows its preview.
 *
 *       Autosave: send `content` on every tick and `thumbnail` on a slower one (15–30 s,
 *       blur, close) — an omitted `thumbnail` keeps the current preview. Content is not
 *       checked beyond its size: which parts a user may change is the editor's rule.
 *       Not metered.
 *     tags: [Frames]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: uid,        required: true, schema: { type: string, format: uuid }, description: "The FRAME uid — `Frame.uid` on a My Frames row, not the row's own `uid`" }
 *       - { in: path, name: versionUid, required: true, schema: { type: string, format: uuid }, description: "A `versions[].uid` of that frame" }
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/FrameDesignRequest' } } }
 *     responses:
 *       200:
 *         description: The saved copy (no content)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/FrameDesignResponse' } } }
 *       400:
 *         description: Missing/oversize content, or a thumbnail that is not a JPEG/PNG/WebP under 500 KB — nothing is saved
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       403:
 *         description: The frame is not in the caller's My Frames
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       404:
 *         description: No live frame with that uid, or no live version of it with that uid
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *   delete:
 *     summary: Reset a frame version to the original
 *     description: >
 *       Deletes the caller's edited copy of this version and its preview;
 *       `GET /frames/{uid}` serves the original again. Removing the frame from My Frames
 *       does this for every version of it.
 *     tags: [Frames]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: uid,        required: true, schema: { type: string, format: uuid }, description: "The FRAME uid — `Frame.uid` on a My Frames row, not the row's own `uid`" }
 *       - { in: path, name: versionUid, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Reset
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 *       404:
 *         description: No such frame or version, or the caller has no edited copy of it
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.put('/mine/:uid/versions/:versionUid', authenticate, validate(saveFrameDesignSchema), controller.saveDesign);
router.delete('/mine/:uid/versions/:versionUid', authenticate, controller.resetDesign);

/**
 * @swagger
 * /frames/{uid}:
 *   get:
 *     summary: Get one frame
 *     description: >
 *       `content` — the design payload of the picked `version` — is served only to a
 *       caller who owns the frame (owning a frame means every version of it). A free
 *       frame must still be added first, so the shelf stays an honest record of what
 *       is in use.
 *
 *       The editor passes the poster it is framing. `size` is STRICT: with no live
 *       version in that size, `version` is null and no `content` is sent — a 4:5 frame
 *       never lands on a 1:1 poster. `language` falls back (the viewer's languages,
 *       then any language, English first). Without `size` the version is picked as a
 *       store card would be. `versions` always lists every active version.
 *     tags: [Frames]
 *     parameters:
 *       - { in: path,  name: uid,      required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: size,     schema: { type: string }, description: "Poster size: template size slug, uid or id" }
 *       - { in: query, name: language, schema: { type: string }, description: "Comma list of language codes in rank order" }
 *     responses:
 *       200:
 *         description: Frame; `content` present only when `owned` is true and a version was picked
 *         content: { application/json: { schema: { $ref: '#/components/schemas/FrameResponse' } } }
 *       404:
 *         description: No active frame with that uid
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/:uid', optionalAuth, rateLimiter.publicTiered, controller.getOne);

/**
 * @swagger
 * /frames/{uid}/add:
 *   post:
 *     summary: Add a free frame to My Frames
 *     description: >
 *       Free frames only. Also the re-add path for a frame that was bought and
 *       later removed — that costs nothing, because it was already paid for.
 *       A premium frame that was never bought is refused with 403. If the caller's
 *       business has no active frame, this one becomes it (`active_frame_id`).
 *     tags: [Frames]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       201:
 *         description: The new My Frames entry
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserFrameResponse' } } }
 *       403:
 *         description: Premium frame — purchase it instead
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       409:
 *         description: Already in My Frames, or a purchase is awaiting payment
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/:uid/add', authenticate, controller.add);

/**
 * @swagger
 * /frames/{uid}/purchase:
 *   post:
 *     summary: Buy a premium frame
 *     description: >
 *       Creates a Razorpay order for the frame's price plus GST and records the
 *       purchase as pending. Confirm it with `POST /subscriptions/verify-payment`
 *       (the same endpoint plans use) — or let the webhook do it. The frame lands
 *       in My Frames on confirmation and is owned permanently — and becomes the
 *       business's active frame if it has none.
 *     tags: [Frames]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       201:
 *         description: "Razorpay order to check out. `type` is `already_owned` when the frame had been bought and removed — nothing to pay."
 *         content: { application/json: { schema: { $ref: '#/components/schemas/FramePurchaseResponse' } } }
 *       400:
 *         description: The frame is free — add it instead
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       409:
 *         description: Already owned
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/:uid/purchase', authenticate, controller.purchase);

module.exports = router;
