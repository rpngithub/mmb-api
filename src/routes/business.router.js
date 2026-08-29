const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/business.controller');
const authenticate = require('../middlewares/authenticate');
const optionalAuth = require('../middlewares/optionalAuth');
const rateLimiter  = require('../middlewares/rateLimiter');
const validate     = require('../middlewares/validate');
const {
  createBusinessSchema, updateBusinessSchema, setKeywordsSchema, setBrandColorsSchema, adoptVariantSchema,
} = require('../validators/business.validator');
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
 *               sub_industry: { type: string, description: "Child industry under `industry` — slug, uid, or numeric id. Mutually exclusive with custom_sub_industry. List the choices with GET /industries?parent={industry}; an empty list is the \"Others\" case." }
 *               custom_sub_industry:
 *                 type: string
 *                 minLength: 2
 *                 maxLength: 100
 *                 description: >-
 *                   The "Others" path — free text typed when the owner can't find their
 *                   sub-industry. Files it as a PENDING industry under `industry` (which is
 *                   then required) for admin approval, and links the business to it right away.
 *                   Publicly the business shows no industry chip until it is approved.
 *                   A name that already exists resolves to that industry instead of filing a duplicate.
 *               keywords:
 *                 type: array
 *                 items: { type: string }
 *                 description: >-
 *                   "My Keywords" — tags describing the products & services, each a numeric id,
 *                   a slug, or the display name. Must already exist (see GET /industries/{ref}/keywords
 *                   for the suggestions); an unknown keyword is a 400.
 *               category_id: { type: integer, deprecated: true, description: "Legacy form of industry (still accepted)" }
 *               description:  { type: string }
 *               logo_s3_key:  { type: string, nullable: true, description: "Key from POST /uploads/presign with slot `business_logo`. A key outside your own namespace, or from a different slot, is rejected. Send null to clear." }
 *               cover_s3_key: { type: string, nullable: true, description: "As logo_s3_key, with slot `business_cover`." }
 *               brand_colors:
 *                 type: array
 *                 maxItems: 6
 *                 description: "Ordered palette; first colour is the primary. See PUT /businesses/{uid}/brand-colors."
 *                 items: { $ref: '#/components/schemas/BrandColor' }
 *     responses:
 *       201:
 *         description: Created business (with its industry and keywords)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BusinessResponse' } } }
 *       409:
 *         description: The account already has a business (one business per user)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *   get:
 *     summary: List my businesses
 *     description: Array for forward compatibility, but an account currently holds at most one business.
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
 *     description: >-
 *       Partial update — every field of POST /businesses is patchable, including the industry
 *       pick. Because an account holds at most one business, this is the ONLY route left to an
 *       owner who has already finished signup: a second POST /businesses is a 409, so changing
 *       industry or suggesting an "Others" sub-industry happens here.
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       description: Any subset of the create fields. Only the industry trio is spelled out here.
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:        { type: string }
 *               description: { type: string }
 *               industry:    { type: string, description: "Industry (business category) — slug, uid, or numeric id" }
 *               sub_industry: { type: string, description: "Child industry under `industry` — slug, uid, or numeric id. Mutually exclusive with custom_sub_industry. List the choices with GET /industries?parent={industry}." }
 *               custom_sub_industry:
 *                 type: string
 *                 minLength: 2
 *                 maxLength: 100
 *                 description: >-
 *                   The "Others" path, exactly as on create — free text for a sub-industry the
 *                   catalogue does not offer. `industry` is required alongside it. Files a PENDING
 *                   child of that industry and moves this business onto it immediately; the label
 *                   stays hidden from GET /industries and from the public storefront until an admin
 *                   approves it, while the owner's own read shows BusinessCategory.status = pending.
 *                   An existing name (case-insensitive) resolves to that row rather than filing a
 *                   duplicate; a previously rejected name is a 400.
 *     responses:
 *       200:
 *         description: Updated business
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BusinessResponse' } } }
 *       400:
 *         description: Unknown industry, a sub_industry that is not a child of it, both sub_industry and custom_sub_industry, or custom_sub_industry with no industry
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
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

// ---- "My Keywords" (owner-scoped) ----
/**
 * @swagger
 * /businesses/{uid}/keywords:
 *   get:
 *     summary: List my keywords for this business
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Array of keywords ({ id, name, slug })
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TagListResponse' } } }
 *   put:
 *     summary: Replace my keywords ("MANAGE" on the My Keywords card)
 *     description: >-
 *       Full replace of the set — send the complete list, not a delta; `[]` clears it.
 *       Every keyword must already exist in the tag catalogue (a numeric id, a slug, or the
 *       display name). There is no custom-keyword path: an unrecognised entry is a 400 naming
 *       it, never a silent drop.
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [keywords]
 *             properties:
 *               keywords: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: The saved keyword set
 *         content: { application/json: { schema: { $ref: '#/components/schemas/TagListResponse' } } }
 *       400:
 *         description: One or more keywords are not in the catalogue
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/:uid/keywords', authenticate, controller.getKeywords);
router.put('/:uid/keywords', authenticate, validate(setKeywordsSchema), controller.setKeywords);

// ---- Brand palette (owner-scoped) ----
/**
 * @swagger
 * /businesses/{uid}/brand-colors:
 *   get:
 *     summary: Get my brand palette
 *     description: Ordered array of `{ hex, label? }` — always an array, `[]` when unset.
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: The palette
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BrandColorListResponse' } } }
 *   put:
 *     summary: Replace my brand palette
 *     description: >-
 *       Full replace — send the whole palette, not a delta; `[]` clears it. **Order is the
 *       meaning**: the first colour is the primary, and it is preserved exactly as sent.
 *       Up to 6 colours. `hex` must be full 6-digit form (`#1A2B3C`) — 3-digit shorthand is
 *       rejected — and is stored upper-cased, so `#ff0000` and `#FF0000` are one colour.
 *       Repeating a colour in one palette is a 400.
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [brand_colors]
 *             properties:
 *               brand_colors:
 *                 type: array
 *                 maxItems: 6
 *                 items: { $ref: '#/components/schemas/BrandColor' }
 *     responses:
 *       200:
 *         description: The saved palette
 *         content: { application/json: { schema: { $ref: '#/components/schemas/BrandColorListResponse' } } }
 *       400:
 *         description: Bad hex, duplicate colour, or more than 6 entries
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/:uid/brand-colors', authenticate, controller.getBrandColors);
router.put('/:uid/brand-colors', authenticate, validate(setBrandColorsSchema), controller.setBrandColors);

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
// headers and documented as `deprecated: true` so Swagger UI strikes them through and
// points at the successor.
/**
 * @swagger
 * /businesses/{uid}/themes:
 *   get:
 *     summary: "[Deprecated] Pre-rename alias of /businesses/{uid}/variants"
 *     deprecated: true
 *     description: >-
 *       Identical to `GET /businesses/{uid}/variants`. Responses carry `Deprecation: true`
 *       and `Link: </api/v1/businesses/{uid}/variants>; rel="successor-version"`.
 *       **Use `/businesses/{uid}/variants`.**
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Array of adopted variants, each with its active template cards
 *         content: { application/json: { schema: { $ref: '#/components/schemas/VariantListResponse' } } }
 *   post:
 *     summary: "[Deprecated] Pre-rename alias of POST /businesses/{uid}/variants"
 *     deprecated: true
 *     description: >-
 *       Identical to `POST /businesses/{uid}/variants`, including the per-VARIANT
 *       entitlement check (403 when the owner's active plan does not cover it) and the
 *       durable grant. Either `variant_uid` or the pre-rename `theme_uid` is accepted on
 *       both paths. **Use `/businesses/{uid}/variants`.**
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
 * /businesses/{uid}/themes/{themeUid}:
 *   delete:
 *     summary: "[Deprecated] Pre-rename alias of DELETE /businesses/{uid}/variants/{variantUid}"
 *     deprecated: true
 *     description: "**Use `/businesses/{uid}/variants/{variantUid}`.**"
 *     tags: [Business]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: uid,      required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: themeUid, required: true, schema: { type: string, format: uuid }, description: "The variant's uid" }
 *     responses:
 *       200:
 *         description: Removed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 */
router.get('/:uid/themes', authenticate, deprecated('/api/v1/businesses/{uid}/variants'), controller.listVariants);
router.post('/:uid/themes', authenticate, deprecated('/api/v1/businesses/{uid}/variants'), validate(adoptVariantSchema), controller.adoptVariant);
router.delete('/:uid/themes/:themeUid', authenticate, deprecated('/api/v1/businesses/{uid}/variants'), controller.removeVariant);

module.exports = router;
