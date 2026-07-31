const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/auth.controller');
const validate     = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const rateLimiter  = require('../middlewares/rateLimiter');
const { sendOtpSchema, verifyOtpSchema, refreshSchema, adminLoginSchema } = require('../validators/auth.validator');

/**
 * @swagger
 * tags:
 *   - name: Auth
 *     description: Authentication — mobile OTP login for users, email+password for admins
 */

/**
 * @swagger
 * /auth/send-otp:
 *   post:
 *     summary: Send OTP to phone number (login & signup combined — creates account on first use)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SendOtpRequest'
 *     responses:
 *       200:
 *         description: OTP sent. In development/staging the `otp` field is included in the response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SendOtpResponse'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       429:
 *         $ref: '#/components/responses/RateLimitError'
 */
router.post('/send-otp', validate(sendOtpSchema), rateLimiter.otpSend, controller.sendOtp);

/**
 * @swagger
 * /auth/verify-otp:
 *   post:
 *     summary: Verify OTP — authenticates user and issues tokens (auto-creates account on first login)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/VerifyOtpRequest'
 *     responses:
 *       200:
 *         description: Authenticated. `is_new_user` is true when account was just created.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       429:
 *         $ref: '#/components/responses/RateLimitError'
 */
router.post('/verify-otp', validate(verifyOtpSchema), rateLimiter.auth, controller.verifyOtp);

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Rotate refresh token and get a new access token
 *     tags: [Auth]
 */
router.post('/refresh', validate(refreshSchema), controller.refresh);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Logout — revokes current access token and session
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 */
router.post('/logout', authenticate, controller.logout);

/**
 * @swagger
 * /auth/admin/login:
 *   post:
 *     summary: Admin login with email and password
 *     tags: [Auth]
 */
router.post('/admin/login', validate(adminLoginSchema), rateLimiter.auth, controller.adminLogin);

module.exports = router;
