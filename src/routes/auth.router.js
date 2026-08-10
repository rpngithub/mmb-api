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
 *         description: OTP sent. In development only, the `otp` field is included in the response; staging and production text it.
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
 *         description: >-
 *           Authenticated. `is_new_user` is true while onboarding is unfinished (show the
 *           personalization flow); `onboarding` says which screen to resume on.
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
 *     description: >-
 *       Refresh tokens are single-use: each call returns a new pair and the token
 *       you sent stops working. Store the new one and send only that next time.
 *
 *       Clients must allow only ONE refresh in flight at a time and queue other
 *       requests behind it. Two concurrent refreshes with the same token cannot
 *       both succeed.
 *
 *       Every failure is a 401; the `error.code` says what to do about it.
 *       `REFRESH_IN_PROGRESS` — a refresh raced with another, or an old token was
 *       retried moments after rotating. Nothing was revoked: retry with the newest
 *       token and do NOT sign the user out.
 *       `TOKEN_REUSE_DETECTED` — an already-used refresh token was replayed, which
 *       is treated as a stolen token. EVERY session for the account has been signed
 *       out and the user must log in again.
 *       Any other code (`UNAUTHORIZED`) — the token or its session is no longer
 *       valid; send the user to login.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refresh_token]
 *             properties:
 *               refresh_token: { type: string }
 *     responses:
 *       200:
 *         description: A new access/refresh pair. The previous refresh token is now dead.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
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
