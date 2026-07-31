const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/business.controller');
const authenticate = require('../middlewares/authenticate');
const optionalAuth = require('../middlewares/optionalAuth');
const rateLimiter  = require('../middlewares/rateLimiter');
const validate     = require('../middlewares/validate');
const { createBusinessSchema, updateBusinessSchema, adoptVariantSchema } = require('../validators/business.validator');
const deprecated = require('../middlewares/deprecated');

/**
 * @swagger
 * tags:
 *   - name: Business
 *     description: Business management (owner-scoped)
 */

/**
 * @swagger
 * /businesses:
 *   post:
 *     summary: Create a business
 *     tags: [Business]
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
 *               industry:    { type: string, description: "Industry (business category) — slug, uid, or numeric id" }
 *               category_id: { type: integer, deprecated: true, description: "Legacy form of industry (still accepted)" }
 *               description:  { type: string }
 *     responses:
 *       201:
 *         description: Created business
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BusinessResponse' } } }
 *   get:
 *     summary: List my businesses
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of businesses
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BusinessListResponse' } } }
 */
router.post('/', authenticate, validate(createBusinessSchema), controller.create);
router.get('/', authenticate, controller.list);

// ---- Public "Near Me" directory (no JWT; tiered public rate limit) ----
// Registered before '/:uid' so the literal '/nearby' isn't captured as a uid.
/**
 * @swagger
 * /businesses/nearby:
 *   get:
 *     summary: Find nearby businesses (public "Near Me")
 *     description: Active businesses within `radius` km of `lat`/`lng`, with computed `distance_km`. Sort by distance (default) or rating.
 *     tags: [Business]
 *     security: []
 *     parameters:
 *       - { in: query, name: lat,         required: true, schema: { type: number } }
 *       - { in: query, name: lng,         required: true, schema: { type: number } }
 *       - { in: query, name: radius,      schema: { type: number, default: 10, maximum: 50 }, description: km }
 *       - { in: query, name: q,           schema: { type: string }, description: Name/description search }
 *       - { in: query, name: category,    schema: { type: string },  description: "Business category — slug, uid, or numeric id" }
 *       - { in: query, name: category_id, deprecated: true, schema: { type: integer }, description: "Legacy numeric-id form of category (still accepted)" }
 *       - { in: query, name: sort,        schema: { type: string, enum: [distance, rating], default: distance } }
 *       - { in: query, name: limit,       schema: { type: integer, default: 20, maximum: 50 } }
 *       - { in: query, name: offset,      schema: { type: integer, default: 0 } }
 *     responses:
 *       200:
 *         description: Array of nearby businesses (each with distance_km and category)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BusinessListResponse' } } }
 *       400:
 *         description: Missing/invalid lat or lng
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/nearby', optionalAuth, rateLimiter.publicTiered, controller.nearby);

/**
 * @swagger
 * /businesses/{uid}/public:
 *   get:
 *     summary: Public business storefront profile
 *     description: Public-safe fields only (contact, hours, rating, geo, category). Active businesses only.
 *     tags: [Business]
 *     security: []
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Public business profile
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BusinessResponse' } } }
 *       404:
 *         description: Not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/:uid/public', optionalAuth, rateLimiter.publicTiered, controller.publicProfile);

/**
 * @swagger
 * /businesses/{uid}/products:
 *   get:
 *     summary: Public product/service list for a business
 *     tags: [Business]
 *     security: []
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Array of active products with images
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProductListResponse' } } }
 *       404:
 *         description: Not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/:uid/products', optionalAuth, rateLimiter.publicTiered, controller.publicProducts);

/**
 * @swagger
 * /businesses/{uid}:
 *   get:
 *     summary: Get a business by uid
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Business object
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BusinessResponse' } } }
 *       404:
 *         description: Not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *   patch:
 *     summary: Update a business (owner only)
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Updated business
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BusinessResponse' } } }
 *       403:
 *         description: Access denied
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *   delete:
 *     summary: Delete a business (owner only, soft delete)
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Deleted
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 */
router.get('/:uid', authenticate, controller.getOne);
router.patch('/:uid', authenticate, validate(updateBusinessSchema), controller.update);
router.delete('/:uid', authenticate, controller.remove);

// ---- Adopted variants ("Use This Brand Series"; owner-scoped) ----
/**
 * @swagger
 * /businesses/{uid}/variants:
 *   get:
 *     summary: List variants adopted into this business (with template cards)
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Array of adopted variants, each with its active template cards
 *         content: { application/json: { schema: { $ref: '#/components/schemas/VariantListResponse' } } }
 *   post:
 *     summary: Adopt a variant into this business ("Use This Brand Series")
 *     description: >-
 *       Requires the owner's ACTIVE subscription plan to entitle the VARIANT (403 otherwise).
 *       Note the button label says brand series but the grant is per-variant: adopting one
 *       variant does not unlock its siblings in the same series. Idempotent - re-adopting an
 *       already-added variant is a no-op. The adoption is a durable grant: the business keeps
 *       access to the variant's templates even if the plan later lapses.
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               variant_uid: { type: string, format: uuid }
 *               theme_uid:   { type: string, format: uuid, deprecated: true, description: "Pre-rename name for `variant_uid`." }
 *     responses:
 *       201:
 *         description: The adopted variant with its template cards
 *         content: { application/json: { schema: { $ref: '#/components/schemas/VariantResponse' } } }
 *       403:
 *         description: Plan does not include this variant, or business not owned by caller
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 * /businesses/{uid}/variants/{variantUid}:
 *   delete:
 *     summary: Remove an adopted variant from this business
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: uid,        required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: variantUid, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Removed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 */
router.get('/:uid/variants', authenticate, controller.listVariants);
router.post('/:uid/variants', authenticate, validate(adoptVariantSchema), controller.adoptVariant);
router.delete('/:uid/variants/:variantUid', authenticate, controller.removeVariant);

// Deprecated aliases (Theme -> Variant rename). Same handlers, annotated with RFC 8594
// headers and kept out of Swagger so new integrations do not discover them.
router.get('/:uid/themes', authenticate, deprecated('/api/v1/businesses/{uid}/variants'), controller.listVariants);
router.post('/:uid/themes', authenticate, deprecated('/api/v1/businesses/{uid}/variants'), validate(adoptVariantSchema), controller.adoptVariant);
router.delete('/:uid/themes/:themeUid', authenticate, deprecated('/api/v1/businesses/{uid}/variants'), controller.removeVariant);

module.exports = router;
