const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/project.controller');
const authenticate = require('../middlewares/authenticate');
const validate     = require('../middlewares/validate');
const { createProjectSchema, updateProjectSchema, createExportSchema } = require('../validators/project.validator');

/**
 * @swagger
 * tags:
 *   - name: Projects
 *     description: User design projects (owner-scoped)
 */

/**
 * @swagger
 * /projects:
 *   post:
 *     summary: Create a project
 *     tags: [Projects]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:        { type: string }
 *               business_id: { type: integer }
 *               template_id: { type: integer }
 *               size_id:     { type: integer }
 *               content:     { type: string }
 *               thumbnail:
 *                 $ref: '#/components/schemas/ProjectThumbnailInput'
 *     responses:
 *       201:
 *         description: Created project
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProjectResponse' } } }
 *   get:
 *     summary: List my projects
 *     tags: [Projects]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of projects
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProjectListResponse' } } }
 */
router.post('/', authenticate, validate(createProjectSchema), controller.create);
router.get('/', authenticate, controller.list);

/**
 * @swagger
 * /projects/{uid}:
 *   get:
 *     summary: Get a project by uid (owner only)
 *     tags: [Projects]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Project object
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProjectResponse' } } }
 *       403:
 *         description: Access denied
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *   patch:
 *     summary: Update a project (owner only) — the editor's autosave call
 *     description: >-
 *       Send whatever changed. `content` and `thumbnail` can travel together, so one
 *       request saves both — no presign/confirm round-trips for the preview. A rejected
 *       thumbnail (not an image, over the size cap) fails the whole request with 400 and
 *       nothing is saved, so content and preview never drift apart.
 *
 *       Autosave guidance: send `content` on your short tick (a couple of seconds is fine);
 *       send `thumbnail` on a slower one — every 15–30 s, on blur, and on close. It is base64
 *       and needs a canvas render, so shipping it on every keystroke is wasted work.
 *     tags: [Projects]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:      { type: string }
 *               content:   { type: string }
 *               status:    { type: string, enum: [draft, published, archived] }
 *               thumbnail:
 *                 $ref: '#/components/schemas/ProjectThumbnailInput'
 *     responses:
 *       200:
 *         description: Updated project; `thumbnail_s3_key` is the new preview key (prepend `cdn_base_url`)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProjectResponse' } } }
 *       400:
 *         description: Invalid thumbnail (not JPEG/PNG/WebP, or over 500 KB) — nothing was saved
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *   delete:
 *     summary: Delete a project (owner only, archived)
 *     tags: [Projects]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Archived
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 */
router.get('/:uid', authenticate, controller.getOne);
router.patch('/:uid', authenticate, validate(updateProjectSchema), controller.update);
router.delete('/:uid', authenticate, controller.remove);

/**
 * @swagger
 * /projects/{uid}/exports:
 *   post:
 *     summary: Record a project export (download/share) — quota-gated
 *     tags: [Projects]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [export_type]
 *             properties:
 *               export_type: { type: string, enum: [download, share] }
 *               platform:    { type: string, enum: [whatsapp, instagram, facebook, direct] }
 *               s3_key:      { type: string }
 *     responses:
 *       201:
 *         description: Created export record
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProjectExportResponse' } } }
 *       403:
 *         description: Access denied (not owner) or quota exceeded
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *   get:
 *     summary: List exports for my project
 *     tags: [Projects]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Array of export records
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProjectExportListResponse' } } }
 */
router.post('/:uid/exports', authenticate, validate(createExportSchema), controller.createExport);
router.get('/:uid/exports', authenticate, controller.listExports);

module.exports = router;
