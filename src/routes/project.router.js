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
 *     description: >-
 *       `template_id` is a template VERSION (one language × size of a design) — the `id` of the
 *       card or version being opened. Both the version and its design must be active (400
 *       otherwise), and a design in a premium variant needs that variant bought, or added to
 *       the caller's business while they hold an active subscription (403).
 *
 *       `project_type` is `image` or `video`. Send `video` when the design has any animation.
 *       Omitted, it is the template's type (`video`/`animated` → `video`); a blank project is
 *       `image`. A project made from a template counts against the plan's **Business Posts
 *       Templates** quota when it is an image and **Video Templates** when it is a video (402
 *       `QUOTA_EXCEEDED` when full). Blank projects count against neither.
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
 *               name:         { type: string }
 *               business_id:  { type: integer }
 *               template_id:  { type: integer }
 *               size_id:      { type: integer }
 *               project_type: { type: string, enum: [image, video] }
 *               content:      { type: string }
 *               thumbnail:
 *                 $ref: '#/components/schemas/ProjectThumbnailInput'
 *     responses:
 *       201:
 *         description: Created project
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProjectResponse' } } }
 *       402:
 *         description: The quota for this project's type is full
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *   get:
 *     summary: List my projects
 *     tags: [Projects]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: type
 *         required: false
 *         schema: { type: string, enum: [image, video] }
 *         description: Only images ("My Posts") or only videos ("My Videos"). Omit for all.
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
 *
 *       `project_type`: send `video` when the first animation is added and `image` when the
 *       last one is removed — only when it changes. On a project made from a template this
 *       moves it to the other plan quota (Business Posts ↔ Video), so it can fail with 402
 *       `QUOTA_EXCEEDED` when that quota is full; nothing is saved then. On a monthly quota
 *       a project is charged to each bucket at most once, so toggling animation back and
 *       forth does not keep spending.
 *     tags: [Projects]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:         { type: string }
 *               content:      { type: string }
 *               status:       { type: string, enum: [draft, published, archived] }
 *               project_type: { type: string, enum: [image, video] }
 *               thumbnail:
 *                 $ref: '#/components/schemas/ProjectThumbnailInput'
 *     responses:
 *       200:
 *         description: Updated project; `thumbnail_s3_key` is the new preview key (prepend `cdn_base_url`)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProjectResponse' } } }
 *       400:
 *         description: Invalid thumbnail (not JPEG/PNG/WebP, or over 500 KB) — nothing was saved
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       402:
 *         description: Changing `project_type` (or restoring an archived project) needs a slot in a full quota — nothing was saved
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
