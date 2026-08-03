const express      = require('express');
const router       = express.Router();
const authenticate = require('../middlewares/authenticate');
const authorizeAdmin = require('../middlewares/authorizeAdmin');
const validate     = require('../middlewares/validate');
const adminCrud    = require('../utils/adminCrud');
const controller   = require('../controllers/admin.controller');
const uploadController = require('../controllers/upload.controller');
const importController = require('../controllers/import.controller');
const { IMPORT_ENTITIES } = require('../services/import.service');
const models       = require('../models');
const {
  createAdminSchema, updateAdminSchema, userStatusSchema, adminStatusSchema, createRoleSchema, updateRoleSchema,
} = require('../validators/admin.validator');
const {
  createSpecialEventSchema, updateSpecialEventSchema, setEventTemplatesSchema,
} = require('../validators/specialEvent.validator');
const {
  createPlanSchema, updatePlanSchema,
  createBillingOptionSchema, updateBillingOptionSchema,
  createFeatureTypeSchema, updateFeatureTypeSchema,
  createPlanFeatureSchema, updatePlanFeatureSchema,
  createCouponSchema, updateCouponSchema, setCouponPlansSchema,
} = require('../validators/plan.validator');
const {
  createTemplateCategorySchema, updateTemplateCategorySchema,
  createBusinessCategorySchema, updateBusinessCategorySchema,
  createTagSchema, updateTagSchema, setTagsSchema, setRelatedIndustriesSchema,
} = require('../validators/category.validator');
const {
  presignSchema, multipartInitiateSchema, presignPartsSchema,
  completeSchema, abortSchema, confirmSchema,
} = require('../validators/upload.validator');
const { bundleConfirmSchema } = require('../validators/templateBundle.validator');
const templatePublish = require('../services/templatePublish');
const couponRules     = require('../services/couponRules');
const { createAppSettingSchema, updateAppSettingSchema } = require('../validators/appSetting.validator');
const {
  createFaqCategorySchema, updateFaqCategorySchema,
  createFaqSchema, updateFaqSchema,
} = require('../validators/faq.validator');
const { createTestimonialSchema, updateTestimonialSchema } = require('../validators/testimonial.validator');
const {
  createBrandSeriesSchema, updateBrandSeriesSchema,
  createVariantSchema, updateVariantSchema,
  createStylePersonalitySchema, updateStylePersonalitySchema,
  createColorSchema, updateColorSchema,
  createVariantBadgeSchema, updateVariantBadgeSchema,
  setVariantTemplatesSchema, setVariantRelationsSchema, setBrandSeriesRelationsSchema,
} = require('../validators/brandSeries.validator');
const deprecated = require('../middlewares/deprecated');
const {
  createAssetSchema, updateAssetSchema,
  createAssetCategorySchema, updateAssetCategorySchema, setAssetTagsSchema,
} = require('../validators/asset.validator');
const {
  createTemplateSchema, updateTemplateSchema, setTemplateRelationsSchema,
  createTemplateSizeSchema, updateTemplateSizeSchema,
} = require('../validators/template.validator');

/**
 * @swagger
 * tags:
 *   - name: Admin
 *     description: >
 *       Admin panel — all routes require an admin bearer token plus the relevant
 *       permission (`*` superuser, `domain.*` domain wildcard, or exact e.g.
 *       `templates.create`). Every mutation is written to activity_logs.
 *
 *
 *       **Generic catalog CRUD** — each resource below exposes the same five
 *       operations (`GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`)
 *       gated by `<permission>.{read|create|update|delete}` (see the `templates`
 *       example documented below):
 *
 *
 *       `/admin/roles` (roles) · `/admin/templates` (templates) ·
 *       `/admin/template-categories` & `/admin/business-categories` (categories) ·
 *       `/admin/variants` & `/admin/variant-badges` (variants) ·
 *       `/admin/brand-series`, `/admin/style-personalities` & `/admin/colors` (brand_series) ·
 *       `/admin/template-sizes` (sizes) ·
 *       `/admin/tags` (tags) · `/admin/assets` & `/admin/asset-categories` (assets) ·
 *       `/admin/special-events` (events) · `/admin/banners` (banners) ·
 *       `/admin/faqs` & `/admin/faq-categories` (faqs) · `/admin/testimonials` (testimonials) ·
 *       `/admin/plans`, `/admin/plan-billing-options` & `/admin/plan-features` (plans) · `/admin/feature-types` (features) ·
 *       `/admin/coupons` (coupons) · `/admin/app-settings` (settings).
 *
 *
 *       **Bulk reorder** — `/admin/template-categories` additionally exposes
 *       `PATCH /reorder` (documented below) for drag-and-drop ordering.
 *
 *
 *       **Coupons** — `/admin/coupons` validates on write: `code` is unique
 *       (case-insensitive) and limited to letters/numbers/`-`/`_`; a `percentage`
 *       coupon cannot exceed 100; `valid_to` must be after `valid_from`; and
 *       `max_uses` cannot be lowered below the redemptions already counted.
 *       `used_count` is system-managed (incremented when a subscription that
 *       carries the coupon activates) and is rejected if sent. Filterable by
 *       `status`, `applicable_to` and `target_audience`. Plan scoping is a separate
 *       relation — see `GET|PUT /admin/coupons/{uid}/plans` below; it owns
 *       `applicable_to`, so don't set that field by hand.
 */

// ---- Admin user management ----
/**
 * @swagger
 * /admin/admins:
 *   get:
 *     summary: List/search admin users
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: search, schema: { type: string }, description: Matches name or email }
 *       - { in: query, name: limit,  schema: { type: integer, default: 20, maximum: 100 } }
 *       - { in: query, name: offset, schema: { type: integer, default: 0 } }
 *     responses:
 *       200:
 *         description: Paged admins (meta.total); password_hash excluded
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AdminUserListResponse' } } }
 *       403: { description: Missing admins.read }
 *   post:
 *     summary: Create an admin user (password hashed)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password, role_id]
 *             properties:
 *               name:     { type: string }
 *               email:    { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *               role_id:  { type: integer }
 *     responses:
 *       201:
 *         description: Created admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AdminUserResponse' } } }
 *       409: { description: Email exists }
 */
router.get('/admins', authenticate, authorizeAdmin('admins.read'), controller.listAdmins);
router.post('/admins', authenticate, authorizeAdmin('admins.create'), validate(createAdminSchema), controller.createAdmin);

/**
 * @swagger
 * /admin/admins/{uid}:
 *   get:
 *     summary: Get an admin user by uid
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Admin object (with Role; password_hash excluded)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AdminUserResponse' } } }
 *       404: { description: Not found }
 *   patch:
 *     summary: Update an admin (name, role, active, password)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Updated admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AdminUserResponse' } } }
 */
router.get('/admins/:uid', authenticate, authorizeAdmin('admins.read'), controller.getAdmin);
router.patch('/admins/:uid', authenticate, authorizeAdmin('admins.update'), validate(updateAdminSchema), controller.updateAdmin);

/**
 * @swagger
 * /admin/admins/{uid}/status:
 *   patch:
 *     summary: Activate / deactivate an admin user (deactivated admins cannot log in)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [is_active], properties: { is_active: { type: integer, enum: [0, 1] } } }
 *     responses:
 *       200:
 *         description: Updated admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AdminUserResponse' } } }
 */
router.patch('/admins/:uid/status', authenticate, authorizeAdmin('admins.update'), validate(adminStatusSchema), controller.setAdminStatus);

// ---- End-user administration ----
/**
 * @swagger
 * /admin/users:
 *   get:
 *     summary: List/search end users
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: limit,  schema: { type: integer, default: 20, maximum: 100 } }
 *       - { in: query, name: offset, schema: { type: integer, default: 0 } }
 *     responses:
 *       200:
 *         description: Paged users (meta.total)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserListResponse' } } }
 */
router.get('/users', authenticate, authorizeAdmin('users.read'), controller.listUsers);

/**
 * @swagger
 * /admin/users/{uid}:
 *   get:
 *     summary: Get a user by uid
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: User object
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserResponse' } } }
 *       404: { description: Not found }
 */
router.get('/users/:uid', authenticate, authorizeAdmin('users.read'), controller.getUser);

/**
 * @swagger
 * /admin/users/{uid}/status:
 *   patch:
 *     summary: Activate / suspend a user
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [is_active], properties: { is_active: { type: integer, enum: [0, 1] } } }
 *     responses:
 *       200:
 *         description: Updated user
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserResponse' } } }
 */
router.patch('/users/:uid/status', authenticate, authorizeAdmin('users.update'), validate(userStatusSchema), controller.setUserStatus);

// ---- Audit trail ----
/**
 * @swagger
 * /admin/activity-logs:
 *   get:
 *     summary: Read the audit trail
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: entity_type, schema: { type: string } }
 *       - { in: query, name: action,      schema: { type: string } }
 *       - { in: query, name: actor_type,  schema: { type: string, enum: [user, admin] } }
 *       - { in: query, name: limit,       schema: { type: integer, default: 50, maximum: 200 } }
 *       - { in: query, name: offset,      schema: { type: integer, default: 0 } }
 *     responses:
 *       200:
 *         description: Paged activity logs (meta.total)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ActivityLogListResponse' } } }
 */
router.get('/activity-logs', authenticate, authorizeAdmin('activity.read'), controller.listActivity);

// ---- Roles (RBAC) ----
router.use('/roles', adminCrud({
  model: models.Role, resource: 'role', permission: 'roles',
  createSchema: createRoleSchema, updateSchema: updateRoleSchema,
  protect: (row) => (row.is_system ? 'System roles cannot be modified or deleted' : null),
}));

// ---- Catalog content (generic CRUD via factory) ----
// The `templates` resource below is documented as the representative example;
// every other resource exposes the identical five operations (see Admin tag).
/**
 * @swagger
 * /admin/templates:
 *   get:
 *     summary: "List (example of the generic admin CRUD pattern; requires <resource>.read)"
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of records
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TemplateAdminListResponse' } } }
 *   post:
 *     summary: "Create (requires <resource>.create; audit-logged)"
 *     description: >-
 *       Templates specifically: a new template is always a draft. `status: active` is rejected
 *       here because the bundle and thumbnail are written by the bundle flow, which needs the
 *       uid this call returns — see the publish gate on PATCH.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object } } } }
 *     responses:
 *       201:
 *         description: Created record
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TemplateAdminResponse' } } }
 *       400: { description: "Validation error (templates: creating straight into `active`)", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *       403: { description: Missing permission }
 * /admin/templates/{id}:
 *   get:
 *     summary: "Get one by id/uid (requires <resource>.read)"
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses: { 200: { description: Record }, 404: { description: Not found } }
 *   patch:
 *     summary: "Update (requires <resource>.update; audit-logged)"
 *     description: >-
 *       Templates specifically — **publish gate**: setting `status: active` is rejected with 400
 *       `VALIDATION_ERROR` unless the template has a bundle (`content`), a `thumbnail_s3_key`,
 *       a `category_id` **or** at least one industry, at least one size and at least one tag.
 *       Each unmet requirement is one `error.details[]` entry keyed by `field`
 *       (`content` · `thumbnail_s3_key` · `category_id` · `size_ids` · `tag_ids` · `name`).
 *       Moving back to `draft`/`inactive` is never gated, and editing a template that is
 *       already `active` does not re-run the check.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Updated record }
 *       400: { description: "Validation error (templates: publishing an incomplete template)", content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
 *   delete:
 *     summary: "Delete (requires <resource>.delete; audit-logged)"
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses: { 200: { description: Deleted } }
 */
// Dedicated admin template list — paginated + filterable, sees every status, and
// drops the heavy `content` blob. Registered before the generic /templates mount
// so it overrides only the list GET; create/update/delete and GET /:uid (full
// content, any status) still come from the generic CRUD factory below.
/**
 * @swagger
 * /admin/templates:
 *   get:
 *     summary: List templates for admin (all statuses, paginated, filterable)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status,               schema: { type: string, enum: [active, inactive, draft] }, description: Omit to list all statuses }
 *       - { in: query, name: search,               schema: { type: string }, description: Name contains }
 *       - { in: query, name: category_id,          schema: { type: integer } }
 *       - { in: query, name: industry_id,          schema: { type: integer }, description: "Industry (business category) id" }
 *       - { in: query, name: business_category_id, deprecated: true, schema: { type: integer }, description: "Deprecated alias of industry_id" }
 *       - { in: query, name: variant_id,           schema: { type: integer } }
 *       - { in: query, name: theme_id,             deprecated: true, schema: { type: integer }, description: "Deprecated alias of variant_id" }
 *       - { in: query, name: size_id,              schema: { type: integer } }
 *       - { in: query, name: tags,                 schema: { type: string }, description: Comma-separated tag ids (ANY) }
 *       - { in: query, name: template_type,        schema: { type: string, enum: [image, video, animated] } }
 *       - { in: query, name: limit,                schema: { type: integer, default: 30, maximum: 100 } }
 *       - { in: query, name: offset,               schema: { type: integer, default: 0 } }
 *     responses:
 *       200:
 *         description: >-
 *           Paged templates (meta.total); `content` excluded from list rows. Each row carries
 *           the completeness signals `tag_count`, `size_count`, `industry_count`, `has_content`
 *           and `has_thumbnail` — the same requirements the publish gate enforces, so an
 *           "incomplete" column needs no extra request per row.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TemplateAdminListResponse' } } }
 *       403: { description: Missing templates.read }
 */
router.get('/templates', authenticate, authorizeAdmin('templates.read'), controller.listTemplates);

// ---- Template bundle ingest (Design B; files uploaded direct to templates/<uid>/ via the
//      generic upload endpoints, then finalized here). Registered before the generic
//      /templates mount so these nested paths win. ----
/**
 * @swagger
 * /admin/templates/{uid}/bundle/confirm:
 *   post:
 *     summary: Finalize a template bundle — flip pending objects to active, save JSON + thumbnail
 *     description: >-
 *       Supply `content`, `thumbnail_filename`, or both (at least one is required). Sending only
 *       `thumbnail_filename` re-points the thumbnail at a file already uploaded under
 *       `templates/{uid}/` — presign it with target `{ type: 'template_file', template_uid }` —
 *       so the thumbnail can be replaced without re-uploading the whole bundle.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             minProperties: 1
 *             properties:
 *               content:            { type: string, description: Editor JSON (bare asset names) }
 *               thumbnail_filename: { type: string, description: "Filename of an image already uploaded under templates/{uid}/" }
 *     responses:
 *       200: { description: Updated template }
 *       400: { description: Neither key supplied, or content is not valid JSON }
 * /admin/templates/{uid}/bundle/reset:
 *   post:
 *     summary: Delete all objects under templates/{uid}/ for a clean re-upload
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Bundle cleared }
 */
router.post('/templates/:uid/bundle/confirm', authenticate, authorizeAdmin('templates.update'), validate(bundleConfirmSchema), controller.confirmTemplateBundle);
router.post('/templates/:uid/bundle/reset',   authenticate, authorizeAdmin('templates.update'), controller.resetTemplateBundle);

// ---- Template relations (unified M2M assignment: tags / sizes / industries / variants) ----
/**
 * @swagger
 * /admin/templates/{uid}/relations:
 *   get:
 *     summary: Read a template's relations (tags, sizes, variants, industries)
 *     description: >-
 *       Industries are returned as `Industries` (matching the `industry_ids` key the PUT takes).
 *       `BusinessCategories` is returned as a deprecated duplicate of the same list.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: "Template with Tags, TemplateSizes, Variants, Industries (+ deprecated BusinessCategories)" }
 *   put:
 *     summary: Set a template's relations (any subset; each provided key is a full replace)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tag_ids:               { type: array, items: { type: integer } }
 *               size_ids:              { type: array, items: { type: integer } }
 *               industry_ids:          { type: array, items: { type: integer } }
 *               business_category_ids: { type: array, items: { type: integer }, deprecated: true, description: "Deprecated alias of industry_ids" }
 *               variant_ids:           { type: array, items: { type: integer } }
 *               theme_ids:             { type: array, items: { type: integer }, deprecated: true, description: "Deprecated alias of variant_ids" }
 *     responses:
 *       200: { description: Updated template with its relations }
 */
router.get('/templates/:uid/relations', authenticate, authorizeAdmin('templates.read'),   controller.getTemplateRelations);
router.put('/templates/:uid/relations', authenticate, authorizeAdmin('templates.update'), validate(setTemplateRelationsSchema), controller.setTemplateRelations);

// ---- S3 direct uploads (presigned, Design B: upload straight to final key tagged
//      status=pending; confirm flips the tag to active. Single PUT for small files,
//      multipart for large. Server derives the key from a typed `target`. Any authed admin.) ----
/**
 * @swagger
 * /admin/uploads/presign:
 *   post:
 *     summary: Presigned single PUT (small files) straight to the final key, tagged pending
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [target, filename]
 *             properties:
 *               target:       { type: object, description: "{ type: image_slot|asset|template_file, ... }" }
 *               filename:     { type: string }
 *               content_type: { type: string }
 *     responses:
 *       200: { description: "{ key, upload_url, required_headers: { x-amz-tagging }, expires_in }" }
 * /admin/uploads/multipart/initiate:
 *   post:
 *     summary: Begin a multipart upload (large files); returns key + upload_id
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 * /admin/uploads/multipart/presign-parts:
 *   post:
 *     summary: Get presigned PUT URLs for the given part numbers
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 * /admin/uploads/multipart/complete:
 *   post:
 *     summary: Complete a multipart upload (parts = [{ part_number, etag }])
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 * /admin/uploads/multipart/abort:
 *   post:
 *     summary: Abort a multipart upload
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 * /admin/uploads/confirm:
 *   post:
 *     summary: Promote uploaded objects from pending to active (tag flip)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [keys], properties: { keys: { type: array, items: { type: string } } } }
 *     responses:
 *       200: { description: "{ keys }" }
 */
router.post('/uploads/presign',                 authenticate, authorizeAdmin(), validate(presignSchema),          uploadController.presign);
router.post('/uploads/multipart/initiate',      authenticate, authorizeAdmin(), validate(multipartInitiateSchema), uploadController.multipartInitiate);
router.post('/uploads/multipart/presign-parts', authenticate, authorizeAdmin(), validate(presignPartsSchema),     uploadController.multipartPresignParts);
router.post('/uploads/multipart/complete',      authenticate, authorizeAdmin(), validate(completeSchema),         uploadController.multipartComplete);
router.post('/uploads/multipart/abort',         authenticate, authorizeAdmin(), validate(abortSchema),           uploadController.multipartAbort);
router.post('/uploads/confirm',                 authenticate, authorizeAdmin(), validate(confirmSchema),         uploadController.confirm);

// ---- CSV bulk import (admin catalog taxonomy: industries, template-categories, variants) ----
// Each entity exposes a template download (import + ?example=1 reference variant) and a
// multipart CSV upload with a `dry_run` flag. Upload validates per row and skips bad rows,
// returning a per-row report. Registered from the import.service entity registry so the
// column spec, parser and templates never drift.
/**
 * @swagger
 * /admin/imports/{entity}/template:
 *   get:
 *     summary: Download a CSV template for bulk import (entity = industries | template-categories | variants)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path,  name: entity,  required: true, schema: { type: string, enum: [industries, template-categories, variants] } }
 *       - { in: query, name: example, schema: { type: boolean }, description: "When true, returns the REFERENCE-ONLY example file (do not upload it)" }
 *     responses:
 *       200: { description: "CSV file (text/csv). Import template by default; reference/example file when example=1", content: { text/csv: { schema: { type: string } } } }
 *       403: { description: Missing <permission>.read }
 * /admin/imports/{entity}:
 *   post:
 *     summary: Upload a CSV to bulk import/upsert records (skip-bad-rows; returns a per-row report)
 *     description: >-
 *       Rows are upserted by `name` (case-insensitive). Parent categories are resolved from a
 *       name/slug column across the file. Uploading the reference/example file is rejected.
 *       Set `dry_run` to validate without writing.
 *       Image columns (`icon_s3_key`, `thumbnail_s3_key`, `series_icon_s3_key`) take an S3 key
 *       for a file the editor has already uploaded — a full URL is accepted and trimmed to the
 *       key. Blank keeps the current image, `NONE` clears it. Key checks (prefix, extension,
 *       reuse, and an S3 existence probe) are ADVISORY: the row still imports and every problem
 *       is listed in `rows[].warnings`.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: entity, required: true, schema: { type: string, enum: [industries, template-categories, variants] } }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:    { type: string, format: binary, description: "The CSV file" }
 *               dry_run: { type: string, description: "1/true to validate only (no writes)" }
 *     responses:
 *       200: { description: "{ entity, dry_run, summary: { total, created, updated, skipped, warnings }, notes: [string], rows: [{ line, name, status, message, warnings }] }" }
 *       400: { description: "Empty file, missing required column, or the reference template was uploaded" }
 *       403: { description: Missing <permission>.create }
 */
for (const { key, permission } of IMPORT_ENTITIES) {
  router.get(`/imports/${key}/template`, authenticate, authorizeAdmin(`${permission}.read`),   importController.template(key));
  router.post(`/imports/${key}`,         authenticate, authorizeAdmin(`${permission}.create`), importController.uploadCsv, importController.run(key));
}

// ---- Business-category tag assignment (full replace; M2M not handled by generic CRUD) ----
/**
 * @swagger
 * /admin/business-categories/{uid}/tags:
 *   put:
 *     summary: Replace the tags assigned to a business category
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [tag_ids], properties: { tag_ids: { type: array, items: { type: integer } } } }
 *     responses:
 *       200: { description: Updated business category with its tags }
 */
router.put('/business-categories/:uid/tags', authenticate, authorizeAdmin('categories.update'), validate(setTagsSchema), controller.setBusinessCategoryTags);

// ---- Related industries: the SEO cross-link block (ordered M2M; full replace) ----
/**
 * @swagger
 * /admin/business-categories/{uid}/related:
 *   get:
 *     summary: Read an industry's related industries (SEO cross-link block)
 *     description: >-
 *       Returns the curated block in the editor's order. Unlike the public catalogue
 *       this includes INACTIVE industries (with `is_active`), so a link that has gone
 *       dark is visible in the admin form instead of silently vanishing.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: "The industry with its ordered `RelatedIndustries`" }
 *       404: { description: Unknown industry }
 *   put:
 *     summary: Replace an industry's related industries (ordered; one-way)
 *     description: >-
 *       Full replace — send the complete list every time; an empty array clears the block.
 *       ARRAY ORDER is the display order, so a drag-and-drop reorder is just another PUT.
 *       The relation is ONE-WAY: setting A → [B, C] does not add A to B's or C's block.
 *       An industry cannot be related to itself (400), and an unknown id rejects the
 *       whole batch (404) rather than curating a shorter block than was sent.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               related_industry_ids: { type: array, items: { type: integer }, description: "Ordered, unique industry ids" }
 *               related_category_ids: { type: array, items: { type: integer }, deprecated: true, description: "Alias of `related_industry_ids`" }
 *     responses:
 *       200: { description: "Updated industry with its ordered `RelatedIndustries`" }
 *       400: { description: "Validation error, or the industry was related to itself" }
 *       404: { description: "Unknown industry, or one or more related ids not found" }
 */
router.get('/business-categories/:uid/related', authenticate, authorizeAdmin('categories.read'),   controller.getRelatedIndustries);
router.put('/business-categories/:uid/related', authenticate, authorizeAdmin('categories.update'), validate(setRelatedIndustriesSchema), controller.setRelatedIndustries);

// ---- Variant <-> template assignment (M2M not handled by generic CRUD) ----
/**
 * @swagger
 * /admin/variants/{uid}/templates:
 *   get:
 *     summary: List templates assigned to a variant
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: "Variant with its Templates (lightweight fields)" }
 *   put:
 *     summary: Replace the templates assigned to a variant
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [template_ids], properties: { template_ids: { type: array, items: { type: integer } } } }
 *     responses:
 *       200: { description: "Updated variant with its Templates" }
 */
router.get('/variants/:uid/templates', authenticate, authorizeAdmin('variants.read'),   controller.getVariantTemplates);
router.put('/variants/:uid/templates', authenticate, authorizeAdmin('variants.update'), validate(setVariantTemplatesSchema), controller.setVariantTemplates);

// ---- Variant relations: plan entitlements (premium gating) + industries (display/filter) ----
/**
 * @swagger
 * /admin/variants/{uid}/relations:
 *   get:
 *     summary: Read a variant's relations (entitled plans, industries, badge)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Variant with its related collections }
 *   put:
 *     summary: Set a variant's relations (any subset; each provided key is a full replace)
 *     description: >-
 *       plan_ids define the premium entitlement - a user may open the variant's templates only if
 *       their active subscription plan is listed. An empty array locks the variant to everyone.
 *       Gating is per-VARIANT, not per-brand-series. industry_ids are the display/filter tags
 *       shown on the variant card.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             minProperties: 1
 *             properties:
 *               plan_ids:              { type: array, items: { type: integer } }
 *               industry_ids:          { type: array, items: { type: integer } }
 *               business_category_ids: { type: array, items: { type: integer }, deprecated: true, description: "Deprecated alias of industry_ids" }
 *     responses:
 *       200: { description: Updated variant with its relations }
 */
router.get('/variants/:uid/relations', authenticate, authorizeAdmin('variants.read'),   controller.getVariantRelations);
router.put('/variants/:uid/relations', authenticate, authorizeAdmin('variants.update'), validate(setVariantRelationsSchema), controller.setVariantRelations);

// ---- Brand series relations: style personalities / tags / colours (descriptive only) ----
/**
 * @swagger
 * /admin/brand-series/{uid}/relations:
 *   get:
 *     summary: Read a brand series' relations (style personalities, tags, colours)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Brand series with its related collections, each in display order }
 *   put:
 *     summary: Set a brand series' relations (any subset; each provided key is a full replace)
 *     description: >-
 *       Purely descriptive - none of these affect access. Style personalities and colours are
 *       ORDERED: the array order is stored as display_order, so dragging to reorder in the admin
 *       needs no separate endpoint. Tags are unordered and drawn from the shared tag pool.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             minProperties: 1
 *             properties:
 *               style_personality_ids: { type: array, items: { type: integer }, description: "Ordered" }
 *               tag_ids:               { type: array, items: { type: integer } }
 *               color_ids:             { type: array, items: { type: integer }, description: "Ordered" }
 *     responses:
 *       200: { description: Updated brand series with its relations }
 */
router.get('/brand-series/:uid/relations', authenticate, authorizeAdmin('brand_series.read'),   controller.getBrandSeriesRelations);
router.put('/brand-series/:uid/relations', authenticate, authorizeAdmin('brand_series.update'), validate(setBrandSeriesRelationsSchema), controller.setBrandSeriesRelations);

// Deprecated aliases (Theme -> Variant rename); excluded from Swagger on purpose.
router.get('/themes/:uid/templates', authenticate, authorizeAdmin('variants.read'),   deprecated('/api/v1/admin/variants/{uid}/templates'), controller.getVariantTemplates);
router.put('/themes/:uid/templates', authenticate, authorizeAdmin('variants.update'), deprecated('/api/v1/admin/variants/{uid}/templates'), validate(setVariantTemplatesSchema), controller.setVariantTemplates);
router.get('/themes/:uid/relations', authenticate, authorizeAdmin('variants.read'),   deprecated('/api/v1/admin/variants/{uid}/relations'), controller.getVariantRelations);
router.put('/themes/:uid/relations', authenticate, authorizeAdmin('variants.update'), deprecated('/api/v1/admin/variants/{uid}/relations'), validate(setVariantRelationsSchema), controller.setVariantRelations);

// ---- Asset <-> tag assignment (M2M not handled by generic CRUD) ----
/**
 * @swagger
 * /admin/assets/{uid}/tags:
 *   get:
 *     summary: List tags assigned to an asset
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: "Asset with its Tags" }
 *   put:
 *     summary: Replace the tags assigned to an asset
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [tag_ids], properties: { tag_ids: { type: array, items: { type: integer } } } }
 *     responses:
 *       200: { description: "Updated asset with its Tags" }
 */
router.get('/assets/:uid/tags', authenticate, authorizeAdmin('assets.read'),   controller.getAssetTags);
router.put('/assets/:uid/tags', authenticate, authorizeAdmin('assets.update'), validate(setAssetTagsSchema), controller.setAssetTags);

// ---- Special event <-> templates: curate the designs surfaced for a festival/event ----
/**
 * @swagger
 * /admin/special-events/{uid}/templates:
 *   get:
 *     summary: List templates linked to a special event
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: "Special event with its Templates (lightweight fields)" }
 *   put:
 *     summary: Replace the templates linked to a special event
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [template_ids], properties: { template_ids: { type: array, items: { type: integer } } } }
 *     responses:
 *       200: { description: "Updated special event with its Templates" }
 */
router.get('/special-events/:uid/templates', authenticate, authorizeAdmin('events.read'),   controller.getEventTemplates);
router.put('/special-events/:uid/templates', authenticate, authorizeAdmin('events.update'), validate(setEventTemplatesSchema), controller.setEventTemplates);

// ---- Coupon <-> plan scoping (M2M not handled by generic CRUD) ----
/**
 * @swagger
 * /admin/coupons/{uid}/plans:
 *   get:
 *     summary: List the plans a coupon is scoped to
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: "Coupon with its scoped plans (empty when applicable_to is all_plans)" }
 *       404: { description: Coupon not found }
 *   put:
 *     summary: Replace the plans a coupon is scoped to
 *     description: >-
 *       Full replace, and it keeps `applicable_to` in step: a non-empty `plan_ids`
 *       sets `specific_plans`, an empty array clears the scoping back to `all_plans`.
 *       Both writes happen in one transaction — the pair is what makes a coupon
 *       redeemable, so setting `applicable_to` by hand on the CRUD endpoint without
 *       plans is rejected (a `specific_plans` coupon with no plans matches nothing).
 *       Access-pass plans are rejected too: they are bought via
 *       `POST /subscriptions/access-pass`, which takes no coupon code, so a coupon
 *       scoped to one could never be redeemed.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [plan_ids], properties: { plan_ids: { type: array, items: { type: integer } } } }
 *     responses:
 *       200: { description: "Updated coupon with its scoped plans" }
 *       400: { description: One or more ids are access-pass plans (details list them) }
 *       404: { description: Coupon not found, or one or more plan ids do not exist }
 */
router.get('/coupons/:uid/plans', authenticate, authorizeAdmin('coupons.read'),   controller.getCouponPlans);
router.put('/coupons/:uid/plans', authenticate, authorizeAdmin('coupons.update'), validate(setCouponPlansSchema), controller.setCouponPlans);

/**
 * @swagger
 * /admin/template-categories/reorder:
 *   patch:
 *     summary: Bulk-reorder template categories (drag-and-drop)
 *     description: >-
 *       Sets `display_order` = array position for each id, in a single
 *       transaction (all-or-nothing). Reorder is sibling-scoped: every id in the
 *       batch must belong to the same parent, otherwise 400. Send the full
 *       ordered list of one sibling group (uids).
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *                 description: Category uids in the desired display order.
 *     responses:
 *       200: { description: "Reordered ({ success: true, data: null })" }
 *       400: { description: "Validation error, or ids span multiple parents" }
 *       404: { description: "One or more ids not found" }
 */
const C = (path, opts) => router.use(path, adminCrud(opts));
// Deprecated path serving the same resource, annotated with RFC 8594 headers.
const COld = (path, successor, opts) => router.use(path, deprecated(successor), adminCrud(opts));

// `beforeWrite` is the server-side publish gate: status may only become `active`
// once the template is complete (bundle + thumbnail + anchor + size + tag). Without
// it the admin panel's checklist is bypassable with a direct PATCH.
C('/templates',           { model: models.Template,         resource: 'template',          permission: 'templates', unique: ['name'], createSchema: createTemplateSchema, updateSchema: updateTemplateSchema, injectOnCreate: (req) => ({ created_by: req.user.userId }), beforeWrite: (payload, row) => templatePublish.assertPublishable(row, payload) });
C('/template-categories', { model: models.TemplateCategory, resource: 'template_category', permission: 'categories', unique: ['name', 'slug'], autoSlug: true, reorderable: true, createSchema: createTemplateCategorySchema, updateSchema: updateTemplateCategorySchema });
C('/business-categories', { model: models.BusinessCategory, resource: 'business_category', permission: 'categories', unique: ['name', 'slug'], autoSlug: true, createSchema: createBusinessCategorySchema, updateSchema: updateBusinessCategorySchema, include: [{ model: models.Tag, through: { attributes: [] } }] });
const VARIANT_CRUD      = { model: models.Variant,     resource: 'variant',      permission: 'variants',     unique: ['name'], filterable: ['series_id', 'badge_id'], filterAlias: { group_id: 'series_id' }, createSchema: createVariantSchema, updateSchema: updateVariantSchema, include: [{ model: models.VariantBadge }] };
const BRAND_SERIES_CRUD = { model: models.BrandSeries, resource: 'brand_series', permission: 'brand_series', unique: ['name', 'slug'], autoSlug: true, createSchema: createBrandSeriesSchema, updateSchema: updateBrandSeriesSchema };
C('/variants',            VARIANT_CRUD);
C('/brand-series',        BRAND_SERIES_CRUD);
C('/style-personalities', { model: models.StylePersonality, resource: 'style_personality', permission: 'brand_series', unique: ['name', 'slug'], autoSlug: true, createSchema: createStylePersonalitySchema, updateSchema: updateStylePersonalitySchema });
C('/colors',              { model: models.Color,            resource: 'color',             permission: 'brand_series', unique: ['name', 'slug'], autoSlug: true, createSchema: createColorSchema, updateSchema: updateColorSchema });
C('/variant-badges',      { model: models.VariantBadge,     resource: 'variant_badge',     permission: 'variants',     unique: ['name', 'slug'], autoSlug: true, createSchema: createVariantBadgeSchema, updateSchema: updateVariantBadgeSchema });
// Pre-rename paths, still served.
COld('/themes',           '/api/v1/admin/variants',     VARIANT_CRUD);
COld('/theme-groups',     '/api/v1/admin/brand-series', BRAND_SERIES_CRUD);
C('/template-sizes',      { model: models.TemplateSize,     resource: 'template_size',    permission: 'sizes', unique: ['name', 'slug'], autoSlug: true, createSchema: createTemplateSizeSchema, updateSchema: updateTemplateSizeSchema });
C('/tags',                { model: models.Tag,              resource: 'tag',              permission: 'tags', idField: 'id', hasUid: false, unique: ['name', 'slug'], autoSlug: true, createSchema: createTagSchema, updateSchema: updateTagSchema });
C('/assets',              { model: models.Asset,            resource: 'asset',            permission: 'assets', filterable: ['category_id', 'asset_type', 'status'], createSchema: createAssetSchema, updateSchema: updateAssetSchema });
C('/asset-categories',    { model: models.AssetCategory,    resource: 'asset_category',   permission: 'assets', unique: ['slug'], autoSlug: true, createSchema: createAssetCategorySchema, updateSchema: updateAssetCategorySchema });
C('/special-events',      { model: models.SpecialEvent,     resource: 'special_event',    permission: 'events', unique: ['name'], createSchema: createSpecialEventSchema, updateSchema: updateSpecialEventSchema });
C('/banners',             { model: models.AppBanner,        resource: 'banner',           permission: 'banners' });
C('/faqs',                { model: models.Faq,              resource: 'faq',              permission: 'faqs', filterable: ['category_id', 'status'], include: [{ model: models.FaqCategory }], createSchema: createFaqSchema, updateSchema: updateFaqSchema });
C('/faq-categories',      { model: models.FaqCategory,      resource: 'faq_category',     permission: 'faqs', unique: ['name', 'slug'], autoSlug: true, createSchema: createFaqCategorySchema, updateSchema: updateFaqCategorySchema });
C('/testimonials',        { model: models.Testimonial,      resource: 'testimonial',      permission: 'testimonials', filterable: ['business_category_id', 'status'], filterAlias: { industry_id: 'business_category_id' }, include: [{ model: models.BusinessCategory }], createSchema: createTestimonialSchema, updateSchema: updateTestimonialSchema });
C('/plans',               { model: models.Plan,             resource: 'plan',             permission: 'plans', createSchema: createPlanSchema, updateSchema: updatePlanSchema });
C('/plan-billing-options',{ model: models.PlanBillingOption, resource: 'plan_billing_option', permission: 'plans', idField: 'id', hasUid: false, filterable: ['plan_id'], createSchema: createBillingOptionSchema, updateSchema: updateBillingOptionSchema });
C('/plan-features',       { model: models.PlanFeature,      resource: 'plan_feature',     permission: 'plans', idField: 'id', hasUid: false, filterable: ['plan_id', 'feature_type_id'], createSchema: createPlanFeatureSchema, updateSchema: updatePlanFeatureSchema });
C('/feature-types',       { model: models.FeatureType,      resource: 'feature_type',     permission: 'features', idField: 'id', hasUid: false, createSchema: createFeatureTypeSchema, updateSchema: updateFeatureTypeSchema });
C('/coupons',             { model: models.Coupon,           resource: 'coupon',           permission: 'coupons', unique: ['code'], filterable: ['status', 'applicable_to', 'target_audience'], createSchema: createCouponSchema, updateSchema: updateCouponSchema, beforeWrite: (payload, row) => couponRules.assertCouponConsistent(payload, row) });
C('/app-settings',        { model: models.AppSetting,       resource: 'app_setting',      permission: 'settings', idField: 'id', hasUid: false, createSchema: createAppSettingSchema, updateSchema: updateAppSettingSchema });

module.exports = router;
