/**
 * Hand-written shapes for the top-up flow. Neither is a model row — one is a
 * Razorpay order assembled per request, the other a computed summary joining plan
 * allowances, purchased balances and recorded usage — so they cannot come from
 * modelSchemas.
 *
 * @swagger
 * components:
 *   schemas:
 *     QuotaPurchaseResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           properties:
 *             type: { type: string, enum: [one_time] }
 *             order_id:
 *               type: string
 *               description: Razorpay order id to hand to Checkout.
 *             amount:
 *               type: number
 *               description: Total payable INCLUDING GST. The pack's stored `price` is pre-tax.
 *             currency: { type: string, example: INR }
 *             payment_uid:
 *               type: string
 *               format: uuid
 *               description: >-
 *                 The pending payment. Confirm it through POST /subscriptions/payment/verify —
 *                 top-ups deliberately reuse that endpoint rather than adding a second one, so
 *                 there is exactly one place a Checkout callback is verified. The webhook
 *                 remains the source of truth; the balance appears on GET /quota/usage once
 *                 the payment is confirmed.
 *             pack_uid: { type: string, format: uuid }
 *
 *     QuotaFeatureUsage:
 *       type: object
 *       description: >-
 *         One feature's entitlement. `limit` and `used` are the PLAN allowance and what has
 *         been drawn from it this cycle — the two numbers the bar fills against. The purchased
 *         balance is reported separately and folded into `effective_limit` and `remaining`.
 *       properties:
 *         key:          { type: string, example: ai_credits }
 *         label:        { type: string, example: AI Credits }
 *         reset_period: { type: string, enum: [monthly, annual, never] }
 *         data_type:    { type: string, enum: [integer, boolean] }
 *         topupable:
 *           type: boolean
 *           description: >-
 *             Whether top-up packs may be sold for this feature. False while enforcement is
 *             suspended (see `enforced`) — there is no ceiling to raise, and the purchase
 *             endpoint refuses the sale.
 *         enforced:
 *           type: boolean
 *           description: >-
 *             Present, and false, ONLY when this feature's limit has been temporarily suspended
 *             server-side. Always accompanied by `unlimited: true` and `topupable: false`, so a
 *             client that already handles `unlimited` needs no change. The plan still declares a
 *             limit — it is simply not being applied, and usage keeps being recorded so it can be
 *             restored without a backfill. Absent means enforced as normal.
 *         enabled:
 *           type: boolean
 *           description: Boolean features only — present instead of every numeric field below.
 *         unit:      { type: string, enum: [count, MB] }
 *         limit:
 *           type: integer
 *           nullable: true
 *           description: The plan allowance, in `unit`. Null when unlimited.
 *         unlimited: { type: boolean }
 *         used:
 *           type: number
 *           description: >-
 *             Drawn from the PLAN allowance this cycle. It never exceeds `limit`: once the
 *             allowance is gone, further spending is debited from the purchased balance
 *             instead, which is what lets this figure reset each month without giving back
 *             credits that were paid for.
 *         topup_granted:
 *           type: number
 *           description: Total purchased, in `unit`. Never expires.
 *         topup_remaining:
 *           type: number
 *           description: Purchased balance still unspent.
 *         effective_limit:
 *           type: number
 *           nullable: true
 *           description: '`limit` + `topup_granted` — the real ceiling once a top-up is applied.'
 *         remaining:
 *           type: number
 *           nullable: true
 *           description: What the account can still actually do. Null when unlimited.
 *         used_bytes:
 *           type: integer
 *           description: Storage only — the exact byte figure, since `used` is rounded to MB for display.
 *         breakdown:
 *           type: array
 *           description: >-
 *             Usage split by the tool that spent it, for the current period. Present only on
 *             GET /quota/usage. Derived from recorded events, so a feature nothing has spent
 *             returns an empty array.
 *           items:
 *             type: object
 *             properties:
 *               source: { type: string, example: image_generation }
 *               label:  { type: string, example: Image Generation }
 *               used:   { type: number, example: 120 }
 *
 *     QuotaUsageResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           properties:
 *             period:
 *               type: object
 *               nullable: true
 *               description: >-
 *                 The current usage window, anchored to the day of the month the subscription
 *                 started. Null when the account has recorded nothing yet, or has no active
 *                 subscription to anchor a cycle to.
 *               properties:
 *                 start: { type: string, format: date }
 *                 end:   { type: string, format: date, description: The "resets on" date to show the user. }
 *             features:
 *               type: array
 *               description: Empty for an account with no active subscription — the free tier is not metered against a plan.
 *               items: { $ref: '#/components/schemas/QuotaFeatureUsage' }
 */
