const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/frame.controller');
const authenticate = require('../middlewares/authenticate');
const optionalAuth = require('../middlewares/optionalAuth');
const rateLimiter  = require('../middlewares/rateLimiter');

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
 *       Active frames only. Signing in is optional — a bearer token marks each card
 *       with `owned` and unlocks nothing else.
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
 *       no refund.
 *     tags: [Frames]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
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
 * /frames/{uid}:
 *   get:
 *     summary: Get one frame
 *     description: >
 *       `content` — the design payload — is served only to a caller who owns the
 *       frame. A free frame must still be added first, so the shelf stays an
 *       honest record of what is in use.
 *     tags: [Frames]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Frame; `content` present only when `owned` is true
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
 *       A premium frame that was never bought is refused with 403.
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
 *       in My Frames on confirmation and is owned permanently.
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
