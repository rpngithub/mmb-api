const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/userFrame.controller');
const authenticate = require('../middlewares/authenticate');
const validate     = require('../middlewares/validate');
const { createFrameSchema, updateFrameSchema } = require('../validators/userFrame.validator');

/**
 * @swagger
 * tags:
 *   - name: Frames
 *     description: User-owned frames (owner-scoped)
 */

/**
 * @swagger
 * /frames:
 *   post:
 *     summary: Create a frame
 *     tags: [Frames]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, s3_key]
 *             properties:
 *               name:       { type: string }
 *               s3_key:     { type: string, description: "Key from POST /uploads/presign with slot `user_frame`. A key outside your own namespace is rejected." }
 *               frame_type: { type: string, enum: [image, animated] }
 *     responses:
 *       201:
 *         description: Created frame
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserFrameResponse' } } }
 *   get:
 *     summary: List my frames
 *     tags: [Frames]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of frames
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserFrameListResponse' } } }
 */
router.post('/', authenticate, validate(createFrameSchema), controller.create);
router.get('/', authenticate, controller.list);

/**
 * @swagger
 * /frames/{uid}:
 *   get:
 *     summary: Get a frame by uid (owner only)
 *     tags: [Frames]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Frame object
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserFrameResponse' } } }
 *       403:
 *         description: Access denied
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *   patch:
 *     summary: Update a frame (owner only)
 *     tags: [Frames]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Updated frame
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserFrameResponse' } } }
 *   delete:
 *     summary: Delete a frame (owner only, soft delete)
 *     tags: [Frames]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Deleted
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 */
router.get('/:uid', authenticate, controller.getOne);
router.patch('/:uid', authenticate, validate(updateFrameSchema), controller.update);
router.delete('/:uid', authenticate, controller.remove);

module.exports = router;
