const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/auth.controller');
const validate     = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const rateLimiter  = require('../middlewares/rateLimiter');
const phoneChange  = require('../controllers/phoneChange.controller');
const email        = require('../controllers/email.controller');
const { sendOtpSchema, verifyOtpSchema, refreshSchema, adminLoginSchema } = require('../validators/auth.validator');
const { linkSendOtpSchema, linkVerifySchema, verifyEmailSchema } = require('../validators/phoneChange.validator');

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

/**
 * @swagger
 * /auth/email/verify:
 *   post:
 *     summary: Verify an email address from the emailed link
 *     description: >-
 *       Public — the token from `{APP_WEB_URL}/verify-email?token=…` is the proof. Refused
 *       (`LINK_INVALID`) once used, after 24 hours, or if the account's email changed since.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [token], properties: { token: { type: string } } } } }
 *     responses:
 *       200: { description: "`{ message, email (masked) }`" }
 *       400: { description: "`LINK_INVALID`" }
 */
router.post('/email/verify', validate(verifyEmailSchema), rateLimiter.auth, email.verify);

/**
 * @swagger
 * /auth/phone-reset/{token}:
 *   get:
 *     summary: "Lost my mobile: open the emailed link"
 *     description: >-
 *       Public — the token from `{APP_WEB_URL}/change-phone?token=…` is the credential.
 *       Read-only, so a mail scanner opening the link first does not spend it. Use
 *       `next_step` to show the right screen: `new_phone` (ask for the number) or
 *       `verify_new` (an OTP was already sent to `new_phone`).
 *     tags: [Auth]
 *     parameters: [{ in: path, name: token, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: "`{ current_phone (masked), expires_at, next_step, new_phone? }`" }
 *       400: { description: "`LINK_INVALID` — used, expired or replaced; request a new one" }
 */
router.get('/phone-reset/:token', rateLimiter.guest, phoneChange.inspectLink);

/**
 * @swagger
 * /auth/phone-reset/send-otp:
 *   post:
 *     summary: "Lost my mobile: the new number — texts it an OTP"
 *     description: Call again to resend, or to correct the number.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [token, phone], properties: { token: { type: string }, phone: { type: string, example: "+919876543210" } } } } }
 *     responses:
 *       200: { description: "`{ phone (masked), next_step: verify_new }` — plus `otp` in development/test" }
 *       400: { description: "`LINK_INVALID`, not an Indian mobile, or already the account's number" }
 *       409: { description: "`PHONE_TAKEN`" }
 */
router.post('/phone-reset/send-otp', validate(linkSendOtpSchema), rateLimiter.otpSend, rateLimiter.accountOtpSend, phoneChange.linkSendOtp);

/**
 * @swagger
 * /auth/phone-reset/verify:
 *   post:
 *     summary: "Lost my mobile: confirm the new number's OTP — the number is changed"
 *     description: >-
 *       Swaps the number and ends every session on the account. No tokens are issued
 *       (this may be a browser on another device): send the user to sign in with the new number.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [token, otp], properties: { token: { type: string }, otp: { type: string } } } } }
 *     responses:
 *       200: { description: "`{ message, phone (masked) }`" }
 *       400: { description: "`LINK_INVALID`" }
 *       401: { description: Wrong or expired OTP }
 *       409: { description: "`PHONE_TAKEN` or `STEP_OUT_OF_ORDER`" }
 */
router.post('/phone-reset/verify', validate(linkVerifySchema), rateLimiter.auth, phoneChange.linkVerify);

module.exports = router;
