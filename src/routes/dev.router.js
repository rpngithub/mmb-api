const express     = require('express');
const router      = express.Router();
const controller  = require('../controllers/devSms.controller');
const validate    = require('../middlewares/validate');
const rateLimiter = require('../middlewares/rateLimiter');
const { testSmsSchema } = require('../validators/dev.validator');

/**
 * @swagger
 * tags:
 *   - name: Dev
 *     description: >
 *       Development-only diagnostics. Mounted only when ENABLE_SMS_TEST=true and
 *       NODE_ENV is not production — see the mount in src/app.js.
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
router.post('/test-sms', rateLimiter.smsTest, validate(testSmsSchema), controller.testSms);

module.exports = router;
