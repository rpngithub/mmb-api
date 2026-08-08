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
 *     description: Products under a user's own business (owner-scoped)
 */

/**
 * @swagger
 * /products:
 *   post:
 *     summary: Create a product under one of my businesses
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
 *               name:         { type: string }
 *               description:  { type: string }
 *               price:        { type: number }
 *     responses:
 *       201:
 *         description: Created product
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProductResponse' } } }
 *       403:
 *         description: Business not owned by caller
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *   get:
 *     summary: List products for one of my businesses
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: business_uid
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Array of products (with images)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProductListResponse' } } }
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
 *     summary: Update a product (owner only)
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200:
 *         description: Updated product
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ProductResponse' } } }
 *   delete:
 *     summary: Delete a product (owner only, soft delete)
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
