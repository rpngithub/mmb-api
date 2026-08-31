const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/devSms.controller');
const notifyController = require('../controllers/devNotification.controller');
const authenticate = require('../middlewares/authenticate');
const validate     = require('../middlewares/validate');
const rateLimiter  = require('../middlewares/rateLimiter');
const { testSmsSchema, testNotificationSchema } = require('../validators/dev.validator');

/**
 * @swagger
 * tags:
 *   - name: Dev
 *     description: >
 *       Development-only diagnostics. The router is mounted whenever NODE_ENV is not
 *       production — see the mount in src/app.js.
 *
 *       `POST /dev/test-sms` additionally requires ENABLE_SMS_TEST=true, because it
 *       spends real SMS credits; the notification tester does not, because it only
 *       writes a row for the caller.
 */

/**
 * @swagger
 * /dev/test-sms:
 *   post:
 *     summary: Send a real OTP text to verify the Ping4SMS wiring (development only)
 *     description: >
 *       Calls the SMS vendor directly, bypassing the development short-circuit that
 *       normally makes send-otp echo the code instead of texting it. Sends the
 *       registered DLT template with a throwaway code; no OTP row is created, so the
 *       code returned cannot be used to log in. Costs a real SMS credit and reaches
 *       the real handset. Use `dry_run` to check configuration without sending.
 *     tags: [Dev]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone]
 *             properties:
 *               phone:   { type: string, example: "+919876543210", description: "Indian mobile, with or without +91" }
 *               dry_run: { type: boolean, default: false, description: "Report config and the exact message without calling the vendor" }
 *     responses:
 *       200:
 *         description: >
 *           The attempt's outcome. Note `vendor.delivered` is false for a vendor
 *           rejection — the endpoint still answers 200, with the vendor's raw body
 *           in `vendor.body`.
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       429:
 *         $ref: '#/components/responses/RateLimitError'
 *       500:
 *         description: SMS_NOT_CONFIGURED — one or more PING4SMS_* variables are unset.
 */
// Gated HERE rather than at the mount, so the notification tester below can exist in
// dev and staging without also switching on an endpoint that costs money on every
// call. Both conditions still have to hold for test-sms: not production (the mount)
// AND an explicit opt-in (this).
if (process.env.ENABLE_SMS_TEST === 'true') {
  router.post('/test-sms', rateLimiter.smsTest, validate(testSmsSchema), controller.testSms);
}

/**
 * @swagger
 * /dev/test-notification:
 *   post:
 *     summary: Put a notification in your own inbox (non-production only)
 *     description: >-
 *       Gives the app, the playground and Postman something to read, mark read and
 *       dismiss, without waiting for a real payment to fail or a nightly scan to run.
 *
 *
 *       It always targets the CALLER — there is no recipient field, because a dev
 *       endpoint that can push into someone else's inbox is a spam endpoint, and this
 *       one is reachable on staging.
 *
 *
 *       It goes through the real dispatch path rather than inserting a row directly,
 *       so it doubles as the answer to "why didn't my notification appear?": if a gate
 *       stopped it, `skipped_reason` names which one (`daily_cap`, `min_gap`,
 *       `marketing_opt_out`, `category_muted`, `render_failed`, …). A `status` of
 *       `scheduled` means quiet hours (9pm–9am IST) deferred it to `deliver_at`.
 *     tags: [Dev]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               code:
 *                 type: string
 *                 default: payment_failed
 *                 description: Any active template code. The default has no placeholders, so an empty body works.
 *               variables:
 *                 type: object
 *                 description: "Values for the template's {{placeholders}}, e.g. { \"credits_count\": 12 }"
 *     responses:
 *       200:
 *         description: Whether it was delivered, and why not if it wasn't
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     code:           { type: string }
 *                     delivered:      { type: boolean }
 *                     skipped_reason: { type: string, nullable: true }
 *                     notification:   { type: object, nullable: true }
 *       401:
 *         description: Not signed in
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       404:
 *         description: No template with that code
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/test-notification', authenticate, validate(testNotificationSchema), notifyController.testNotification);

module.exports = router;
