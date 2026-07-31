const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/user.controller');
const authenticate = require('../middlewares/authenticate');
const validate     = require('../middlewares/validate');
const { upsertBillingSchema } = require('../validators/billing.validator');

/**
 * @swagger
 * tags:
 *   - name: User
 *     description: User profile & billing (self)
 */

/**
 * @swagger
 * /users/me:
 *   get:
 *     summary: Get my profile
 *     tags: [User]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: User profile
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserResponse' } } }
 *   patch:
 *     summary: Update my profile
 *     tags: [User]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Updated profile
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserResponse' } } }
 */
router.get('/me', authenticate, controller.getProfile);
router.patch('/me', authenticate, controller.updateProfile);

/**
 * @swagger
 * /users/me/password:
 *   patch:
 *     summary: Change password
 *     tags: [User]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [current_password, new_password]
 *             properties:
 *               current_password: { type: string }
 *               new_password:     { type: string }
 *     responses:
 *       200:
 *         description: Password changed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 */
router.patch('/me/password', authenticate, controller.changePassword);

/**
 * @swagger
 * /users/me/billing:
 *   get:
 *     summary: Get my billing details
 *     tags: [User]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Billing details (or null)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserBillingDetailResponse' } } }
 *   put:
 *     summary: Create or update my billing details (GSTIN, address)
 *     tags: [User]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [billing_name, billing_address, billing_state, billing_pincode]
 *             properties:
 *               billing_name:    { type: string }
 *               gstin:           { type: string }
 *               billing_address: { type: string }
 *               billing_state:   { type: string }
 *               billing_pincode: { type: string }
 *     responses:
 *       200:
 *         description: Saved billing details
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserBillingDetailResponse' } } }
 */
router.get('/me/billing', authenticate, controller.getBilling);
router.put('/me/billing', authenticate, validate(upsertBillingSchema), controller.upsertBilling);

module.exports = router;
