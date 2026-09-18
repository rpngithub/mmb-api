const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/product.controller');
const authenticate = require('../middlewares/authenticate');
const validate     = require('../middlewares/validate');
const { createProductSchema, updateProductSchema, addImageSchema } = require('../validators/product.validator');

/**
 * @swagger
 * tags:
 *   - name: Products
 *     description: >-
 *       Products AND services under a user's own business (owner-scoped). One resource,
 *       told apart by `type`: a product carries `unit` (Unit/Weight), a service carries
 *       `service_area`. `is_active` is the owner's show/hide toggle (the "In Active" tab);
 *       DELETE is permanent.
 */

/**
 * @swagger
 * /products:
 *   post:
 *     summary: Create a product or service under one of my businesses
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business_uid, name]
 *             properties:
 *               business_uid: { type: string, format: uuid }
 *               type:         { type: string, enum: [product, service], default: product }
 *               name:         { type: string, maxLength: 200 }
 *               unit:         { type: string, maxLength: 50, description: "Unit/Weight, display text (\"1 Kg\", \"500 ml\"). Products only — 400 on a service." }
 *               service_area: { type: string, maxLength: 200, description: "Where the service is offered. Services only — 400 on a product." }
 *               description:  { type: string }
 *               price:        { type: number, description: "The actual price. Struck through on the card when `offer_price` is set." }
 *               offer_price:  { type: number, description: "Selling price when on offer. Requires `price` and cannot exceed it — 400 otherwise." }
 *     responses:
 *       201:
 *         description: Created item
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProductResponse' } } }
 *       400:
 *         description: Field for the other type, or offer_price above price
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       403:
 *         description: Business not owned by caller
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *   get:
 *     summary: List products and services for one of my businesses
 *     description: >-
 *       Everything the business still has — active AND inactive — newest first, so one call
 *       drives every tab of Manage Products. `meta.counts` carries the tab badges
 *       (`all`, `products`, `services`, `inactive`) and is always computed over the whole
 *       business, regardless of the filters applied to `data`.
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: business_uid
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: type
 *         required: false
 *         schema: { type: string, enum: [product, service] }
 *       - in: query
 *         name: is_active
 *         required: false
 *         schema: { type: integer, enum: [0, 1] }
 *         description: "0 = the In Active tab"
 *     responses:
 *       200:
 *         description: Array of products/services (with images) plus tab counts
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ProductListResponse'
 *                 - type: object
 *                   properties:
 *                     meta:
 *                       type: object
 *                       properties:
 *                         counts:
 *                           type: object
 *                           properties:
 *                             all:      { type: integer, example: 8 }
 *                             products: { type: integer, example: 6 }
 *                             services: { type: integer, example: 2 }
 *                             inactive: { type: integer, example: 2 }
 */
router.post('/', authenticate, validate(createProductSchema), controller.create);
router.get('/', authenticate, controller.list);

/**
 * @swagger
 * /products/{uid}:
 *   get:
 *     summary: Get a product by uid (owner only)
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Product (with images)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProductResponse' } } }
 *       403:
 *         description: Access denied
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *   patch:
 *     summary: Update a product/service (owner only)
 *     description: >-
 *       Partial. `is_active: 0` hides the item from the storefront (the "In Active" tab) and
 *       `1` shows it again — this is the toggle, not DELETE. Send `null` to clear `unit`,
 *       `service_area`, `price` or `offer_price`. Changing `type` drops the detail that no
 *       longer applies (`unit` on a service, `service_area` on a product) unless the body
 *       sends it, which is a 400. `offer_price` is checked against the STORED `price`
 *       when the body omits one of the pair.
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:         { type: string, enum: [product, service] }
 *               name:         { type: string, maxLength: 200 }
 *               unit:         { type: string, maxLength: 50, nullable: true }
 *               service_area: { type: string, maxLength: 200, nullable: true }
 *               description:  { type: string }
 *               price:        { type: number, nullable: true }
 *               offer_price:  { type: number, nullable: true }
 *               is_active:    { type: integer, enum: [0, 1] }
 *     responses:
 *       200:
 *         description: Updated item
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProductResponse' } } }
 *       400:
 *         description: Field for the other type, or offer_price above price
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *   delete:
 *     summary: Delete a product/service (owner only)
 *     description: >-
 *       Permanent from the owner's point of view — the item leaves every list, including
 *       "In Active", and its images are released from the storage quota. To merely hide
 *       it, PATCH `is_active: 0` instead.
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Deleted
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 */
router.get('/:uid', authenticate, controller.getOne);
router.patch('/:uid', authenticate, validate(updateProductSchema), controller.update);
router.delete('/:uid', authenticate, controller.remove);

/**
 * @swagger
 * /products/{uid}/images:
 *   post:
 *     summary: Add an image to a product (owner only)
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [s3_key]
 *             properties:
 *               s3_key:        { type: string, description: "Key from POST /uploads/presign with slot `product_image`. A key outside your own namespace is rejected." }
 *               display_order: { type: integer }
 *     responses:
 *       201:
 *         description: Created image
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProductImageResponse' } } }
 */
router.post('/:uid/images', authenticate, validate(addImageSchema), controller.addImage);

/**
 * @swagger
 * /products/{uid}/images/{imageId}:
 *   delete:
 *     summary: Remove a product image (owner only)
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: uid, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: imageId, required: true, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: Removed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 */
router.delete('/:uid/images/:imageId', authenticate, controller.removeImage);

module.exports = router;
