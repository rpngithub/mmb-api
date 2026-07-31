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
 *     summary: Update a project (owner only)
 *     tags: [Projects]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Updated project
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProjectResponse' } } }
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
