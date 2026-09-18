const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/subscription.controller');
const authenticate = require('../middlewares/authenticate');
const validate     = require('../middlewares/validate');
const { createSubscriptionSchema, verifyCouponSchema, verifyPaymentSchema } = require('../validators/subscription.validator');

/**
 * @swagger
 * tags:
 *   - name: Subscriptions
 *     description: Plan & subscription management (Razorpay one-time + recurring)
 */

/**
 * @swagger
 * /subscriptions/webhook:
 *   post:
 *     summary: Razorpay webhook (source of truth for payment state)
 *     description: Public endpoint authenticated by the `x-razorpay-signature` HMAC over the raw body — NOT JWT. Handles payment.captured/order.paid, subscription.activated/charged/halted/cancelled. Idempotent.
 *     tags: [Subscriptions]
 *     security: []
 *     parameters:
 *       - in: header
 *         name: x-razorpay-signature
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { event: { type: string }, payload: { type: object } } }
 *     responses:
 *       200:
 *         description: Acknowledged
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 *       401:
 *         description: Invalid signature
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/webhook', controller.webhook);

/**
 * @swagger
 * /subscriptions/plans:
 *   get:
 *     deprecated: true
 *     summary: "[Deprecated] List active plans — use GET /plans instead"
 *     description: Backward-compatible alias of the public catalog `GET /plans`. New clients should call `/plans`, which also carries the public tiered rate limit. This path will be removed in a future release.
 *     tags: [Subscriptions]
 *     security: []
 *     responses:
 *       200:
 *         description: Array of plans
 *         content: { application/json: { schema: { $ref: '#/components/schemas/PlanListResponse' } } }
 */
router.get('/plans', controller.listPlans);

/**
 * @swagger
 * /subscriptions/me:
 *   get:
 *     summary: Get the signed-in user's current subscription & entitlements
 *     description: >
 *       Returns the user's ACTIVE subscription with its plan, per-feature entitlements
 *       (limit/used/remaining, or enabled for booleans), and billing cycle. Poll this
 *       after checkout to detect activation (the webhook flips the sub to active). When
 *       there is no active subscription, `has_active_subscription` is false and the user
 *       should be treated as free tier. Pending/expired/overridden rows are not returned.
 *     tags: [Subscriptions]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Current subscription state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     has_active_subscription: { type: boolean }
 *                     is_on_trial:             { type: boolean }
 *                     subscription:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         uid:         { type: string }
 *                         status:      { type: string, enum: [active] }
 *                         sub_type:    { type: string, enum: [regular, trial, access_pass] }
 *                         auto_renew:  { type: boolean }
 *                         starts_at:   { type: string, format: date-time }
 *                         ends_at:     { type: string, format: date-time }
 *                         renews_on:   { type: string, format: date-time, nullable: true, description: 'Next charge date (= ends_at) while auto-renewing; null when nothing will renew, in which case ends_at is the expiry' }
 *                         renewal_cancelled_at: { type: string, format: date-time, nullable: true, description: 'Set once renewal was stopped; access continues to ends_at' }
 *                         cancel_renewal_allowed: { type: boolean, description: 'True only for a live recurring mandate — drives the Cancel Renewal button' }
 *                         amount_paid: { type: number }
 *                         payment_gateway:       { type: string, nullable: true, enum: [razorpay] }
 *                         payment_method:        { type: string, nullable: true, enum: [upi, card, netbanking, wallet, emi, other], description: 'From the latest successful charge; null until the webhook reports it (or for an uncharged trial)' }
 *                         payment_method_detail: { type: string, nullable: true, example: 'UPI · pr***@okaxis' }
 *                     plan:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         uid:         { type: string }
 *                         name:        { type: string }
 *                         description: { type: string }
 *                         plan_type:   { type: string, enum: [subscription, access_pass] }
 *                     billing:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         cycle:    { type: string, enum: [monthly, annual] }
 *                         price:    { type: number }
 *                         currency: { type: string }
 *                     features:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           key:          { type: string }
 *                           label:        { type: string }
 *                           data_type:    { type: string, enum: [integer, boolean] }
 *                           reset_period: { type: string, enum: [monthly, annual, never] }
 *                           enabled:      { type: boolean, description: 'boolean features only' }
 *                           limit:        { type: integer, nullable: true, description: 'null = unlimited (counter features)' }
 *                           unlimited:    { type: boolean }
 *                           used:         { type: integer }
 *                           remaining:    { type: integer, nullable: true }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get('/me', authenticate, controller.mySubscription);

/**
 * @swagger
 * /subscriptions/me/cancel-renewal:
 *   post:
 *     summary: Stop the active subscription from renewing (access continues to the end of the paid term)
 *     description: >-
 *       Cancels the recurring mandate at Razorpay AT CYCLE END. The subscription stays active
 *       with `auto_renew=false` until `ends_at`, then expires; no further charge is taken.
 *       Also stops an uncharged free trial from converting. Idempotent: a subscription already
 *       winding down returns 200 with `idempotent: true`. There is no resume — Razorpay does not
 *       reinstate a cancelled mandate — so a change of heart is a new subscription.
 *     tags: [Subscriptions]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Renewal stopped
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     subscription_uid:     { type: string }
 *                     auto_renew:           { type: boolean, example: false }
 *                     access_until:         { type: string, format: date-time }
 *                     renewal_cancelled_at: { type: string, format: date-time }
 *                     can_resume:           { type: boolean, example: false }
 *                     idempotent:           { type: boolean, description: 'Present when renewal was already stopped' }
 *       404:
 *         description: No active subscription
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       409:
 *         description: The subscription does not auto-renew (one-time plan / access pass)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       502:
 *         description: The gateway refused the cancellation; nothing was changed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/me/cancel-renewal', authenticate, controller.cancelRenewal);

/**
 * @swagger
 * /subscriptions/payments:
 *   get:
 *     summary: My payment history (Billing & Payments screen)
 *     description: >-
 *       Every payment the user started, newest first — successful, pending and failed alike.
 *       `last_transaction` (page 1 only) is the newest SUCCESSFUL row, for the "Last transaction"
 *       card. `documents_available` says whether the invoice/receipt endpoint will serve the row.
 *     tags: [Subscriptions]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200:
 *         description: Payment history
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     items:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/PaymentHistoryRow' }
 *                     last_transaction:
 *                       allOf: [{ $ref: '#/components/schemas/PaymentHistoryRow' }]
 *                       nullable: true
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         page: { type: integer }
 *                         limit: { type: integer }
 *                         total: { type: integer }
 *                         total_pages: { type: integer }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get('/payments', authenticate, controller.listPayments);

/**
 * @swagger
 * /subscriptions/payments/{uid}/document:
 *   get:
 *     summary: Invoice or receipt for one successful payment (HTML)
 *     description: >-
 *       Returns a self-contained, print-ready HTML page — open it in a tab/webview and use the
 *       browser's Print / Save as PDF. `invoice` is the GST tax invoice (seller & buyer GSTIN,
 *       SAC, CGST+SGST or IGST by the buyer's billing state, coupon noted); `receipt` is the
 *       payment acknowledgment (reference, method, date, amount). The invoice number is issued
 *       when the payment succeeds and never changes. Buyer details come from
 *       `PUT /users/me/billing` when set, else the account's name and contact.
 *     tags: [Subscriptions]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *         description: Payment uid from the history list
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [invoice, receipt], default: invoice }
 *     responses:
 *       200:
 *         description: The document
 *         content: { text/html: { schema: { type: string } } }
 *       403:
 *         description: Not this user's payment
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       404:
 *         description: Payment not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       409:
 *         description: Payment not successful — no document exists
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/payments/:uid/document', authenticate, controller.paymentDocument);

/**
 * @swagger
 * /subscriptions/coupon/verify:
 *   post:
 *     summary: Verify a coupon code for a plan
 *     description: >-
 *       Applies the full redemption rule set for the signed-in user against `plan_id`:
 *       status/validity window, usage cap (`max_uses`), plan restriction
 *       (`applicable_to='specific_plans'`) and audience (`new_users`/`existing_users`).
 *       A coupon that passes here will be accepted by `POST /subscriptions`.
 *     tags: [Subscriptions]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, plan_id]
 *             properties:
 *               code:    { type: string }
 *               plan_id: { type: integer }
 *     responses:
 *       200:
 *         description: Coupon details
 *         content: { application/json: { schema: { $ref: '#/components/schemas/CouponPublicResponse' } } }
 *       404:
 *         description: Coupon not found or expired
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       409:
 *         description: Coupon exists but is not redeemable (usage limit, wrong plan, or wrong audience)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/coupon/verify', authenticate, validate(verifyCouponSchema), controller.verifyCoupon);

/**
 * @swagger
 * /subscriptions:
 *   post:
 *     summary: Initiate a subscription (one-time order or recurring)
 *     description: >-
 *       Creates a pending subscription and returns either a Razorpay order (one-time) or a
 *       subscription short_url (recurring), based on the billing option. An unknown, expired
 *       or non-redeemable `coupon_code` fails the request (404/409) rather than silently
 *       charging full price; the coupon's `used_count` is consumed only once the
 *       subscription activates, so an abandoned checkout does not burn a capped coupon.
 *     tags: [Subscriptions]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [plan_billing_option_id]
 *             properties:
 *               plan_billing_option_id: { type: integer }
 *               coupon_code:            { type: string }
 *     responses:
 *       201:
 *         description: Order or subscription handle to drive Checkout
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 *       404:
 *         description: Billing option not found, or coupon not found/expired
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       409:
 *         description: Coupon not redeemable, trial already used, or plan not configured for trials
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/', authenticate, validate(createSubscriptionSchema), controller.initiate);

/**
 * @swagger
 * /subscriptions/access-pass:
 *   post:
 *     summary: Buy the one-time ₹10 access pass
 *     description: Creates a pending one-time access-pass subscription and returns a Razorpay order. Grants the access-pass plan's features for its pass_days, then expires (reverts to free). Allowed once per user, ever.
 *     tags: [Subscriptions]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201:
 *         description: Razorpay order to drive Checkout
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 *       409:
 *         description: Access pass already used
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/access-pass', authenticate, controller.initiateAccessPass);

/**
 * @swagger
 * /subscriptions/payment/verify:
 *   post:
 *     summary: Verify a Razorpay payment signature (post-Checkout callback)
 *     description: UX confirmation that activates idempotently; the webhook remains the source of truth.
 *     tags: [Subscriptions]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [razorpay_order_id, razorpay_payment_id, razorpay_signature]
 *             properties:
 *               razorpay_order_id:   { type: string }
 *               razorpay_payment_id: { type: string }
 *               razorpay_signature:  { type: string }
 *     responses:
 *       200:
 *         description: Verified
 *         content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } }
 *       401:
 *         description: Invalid payment signature
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/payment/verify', authenticate, validate(verifyPaymentSchema), controller.verifyPayment);

module.exports = router;
