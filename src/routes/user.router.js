const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/user.controller');
const authenticate = require('../middlewares/authenticate');
const validate     = require('../middlewares/validate');
const { upsertBillingSchema } = require('../validators/billing.validator');
const {
  updateProfileSchema, setPasswordSchema, changePasswordSchema, updatePreferencesSchema,
} = require('../validators/user.validator');

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
 *     description: >-
 *       Only `name`, `email` and `account_type` are writable — every other column on
 *       the user is server-owned. `account_type` answers step 2 of signup ("What brings
 *       you here?"): `personal` completes onboarding immediately, `business` continues
 *       into the industry picker. It can only be set while onboarding is still open;
 *       afterwards changing it is a 409.
 *     tags: [User]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             minProperties: 1
 *             properties:
 *               name:         { type: string }
 *               email:        { type: string, format: email, nullable: true }
 *               account_type: { type: string, enum: [business, personal] }
 *               profile_photo_s3_key: { type: string, nullable: true, description: "Key from POST /uploads/presign with slot `profile_photo`. Send null to clear." }
 *     responses:
 *       200:
 *         description: Updated profile (with the `onboarding` block)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserResponse' } } }
 *       409:
 *         description: Account type cannot be changed after signup
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/me', authenticate, controller.getProfile);
router.patch('/me', authenticate, validate(updateProfileSchema), controller.updateProfile);

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
/**
 * @swagger
 * /users/me/password:
 *   post:
 *     summary: Set a first password (OTP-only accounts)
 *     description: >-
 *       For accounts that sign in with OTP and have no password yet — check `has_password`
 *       on `GET /users/me`. No current password is required: the proof is the live session,
 *       which is itself the result of an OTP. Returns 409 if a password already exists
 *       (use PATCH to change it). Ends all OTHER sessions.
 *     tags: [User]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [new_password]
 *             properties:
 *               new_password: { type: string, minLength: 8 }
 *     responses:
 *       200:
 *         description: Password set; other sessions ended
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SessionActionResponse' } } }
 *       409:
 *         description: A password is already set
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/me/password', authenticate, validate(setPasswordSchema), controller.setPassword);
router.patch('/me/password', authenticate, validate(changePasswordSchema), controller.changePassword);

/**
 * @swagger
 * /users/me/sessions/revoke-others:
 *   post:
 *     summary: Log out of all other devices
 *     description: >-
 *       Ends every session except the one making the call. Takes effect immediately —
 *       each revoked session's access token is blacklisted, not just its refresh token —
 *       so other devices are rejected on their very next request.
 *     tags: [User]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Other sessions ended
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SessionActionResponse' } } }
 */
router.post('/me/sessions/revoke-others', authenticate, controller.revokeOtherSessions);

/**
 * @swagger
 * /users/me/deactivate:
 *   post:
 *     summary: Deactivate my account (permanently deleted after the grace period)
 *     description: >-
 *       Switches the account off and ends EVERY session, including this one — the client
 *       should discard its tokens and return to the login screen. Neither OTP login nor
 *       token refresh will work afterwards, and the owner's business disappears from the
 *       public directory.
 *
 *       This also starts a deletion clock. Once the grace period passes (admin setting
 *       `account_deletion_grace_hours`, default 24) everything the account owns —
 *       business, products, projects, uploads, purchased frames, quota, preferences — is
 *       permanently deleted and cannot be recovered. `deletion_scheduled_at` in the
 *       response is when that happens; show it to the user. Within the window an admin
 *       can reactivate the account, which cancels the deletion with nothing lost.
 *       Payment history is retained (tax records) against an anonymised record.
 *     tags: [User]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Account deactivated; every session ended, including this one
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:               { type: string, example: Account deactivated }
 *                     sessions_ended:        { type: integer, example: 2 }
 *                     deletion_scheduled_at: { type: string, format: date-time, description: When the account's data is permanently deleted unless an admin reactivates it first }
 */
router.post('/me/deactivate', authenticate, controller.deactivate);

/**
 * @swagger
 * /users/me/preferences:
 *   get:
 *     summary: Get my preferences
 *     description: Always returns a full object — defaults are applied for users who have never saved any.
 *     tags: [User]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: The effective preferences
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserPreferencesResponse' } } }
 *   patch:
 *     summary: Update my preferences
 *     description: >-
 *       Partial update — send only what changed. `languages` is "Preferred Languages": a
 *       MULTI-SELECT of CONTENT languages that decides which templates the user is shown
 *       (not the app's UI language). It is a full replace — send the whole set; `[]` resets
 *       to the default. Entries are codes ('ta'), uids or ids from `GET /languages`; an
 *       unknown one is a 400 naming it. The notify_* flags cover TRANSACTIONAL messages
 *       (subscription expiry, order updates); they are not a marketing opt-in, and OTP
 *       delivery is part of signing in and ignores them.
 *     tags: [User]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             minProperties: 1
 *             properties:
 *               languages:       { type: array, items: { type: string }, example: ['en', 'ml'] }
 *               notify_push:     { type: boolean }
 *               notify_email:    { type: boolean }
 *               notify_whatsapp: { type: boolean }
 *     responses:
 *       200:
 *         description: The saved preferences
 *         content: { application/json: { schema: { $ref: '#/components/schemas/UserPreferencesResponse' } } }
 *       400:
 *         description: Unknown or inactive language
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/me/preferences', authenticate, controller.getPreferences);
router.patch('/me/preferences', authenticate, validate(updatePreferencesSchema), controller.updatePreferences);

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
