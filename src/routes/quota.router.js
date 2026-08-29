const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/quota.controller');
const authenticate = require('../middlewares/authenticate');
const optionalAuth = require('../middlewares/optionalAuth');
const rateLimiter  = require('../middlewares/rateLimiter');

/**
 * @swagger
 * tags:
 *   - name: Quota
 *     description: >
 *       Usage and top-ups. A plan sets an allowance per feature; a top-up pack is
 *       bought outright to add headroom on top of it and never expires — it
 *       survives both the monthly reset and a lapsed subscription, because no
 *       subscription granted it.
 *
 *
 *       Two shapes of quota behave differently. Storage is a LEVEL: a top-up
 *       raises the ceiling, and deleting a file frees the purchased space again.
 *       AI credits are a monthly TALLY: the plan allowance is spent first and
 *       resets each cycle, and only the overflow is drawn from the purchased
 *       balance, which does not.
 */

/**
 * @swagger
 * /quota/usage:
 *   get:
 *     summary: The signed-in user's usage, allowances and top-up balances
 *     description: >
 *       Everything the Usage screen renders: the current billing period (`period.end`
 *       is the "resets on" date), and one entry per feature the active plan declares.
 *
 *
 *       For each metered feature, `limit` is the PLAN allowance and `used` is what has
 *       been drawn from it this cycle — so the bar fills against those two. `topup_granted`
 *       and `topup_remaining` are the purchased balance, `effective_limit` is the two
 *       added together, and `remaining` is what the account can still actually do.
 *
 *
 *       `breakdown` splits usage by the tool that spent it ("Image Generation",
 *       "Background Removal") for the current period. It is derived from recorded
 *       events, so a feature nothing has spent yet returns an empty array.
 *
 *
 *       An account with no active subscription gets `features: []` — the free tier is
 *       not metered against a plan.
 *     tags: [Quota]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Usage summary.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/QuotaUsageResponse' } } }
 *       401:
 *         description: Not signed in.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/usage', authenticate, controller.usage);

/**
 * @swagger
 * /quota/packs:
 *   get:
 *     summary: Browse the top-up packs on sale
 *     description: >
 *       Active packs only, in the order the admin arranged them. `price` is pre-tax;
 *       `total_price` is what Razorpay will actually be asked for, and is the figure
 *       to show on the card.
 *     tags: [Quota]
 *     parameters:
 *       - in: query
 *         name: feature
 *         schema: { type: string, example: ai_credits }
 *         description: "Feature key to filter by. An unknown key returns an empty shelf, not the whole store."
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 30, maximum: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: The packs on sale.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/QuotaPackListResponse' } } }
 */
router.get('/packs', optionalAuth, rateLimiter.publicTiered, controller.listPacks);

/**
 * @swagger
 * /quota/packs/{uid}:
 *   get:
 *     summary: One top-up pack
 *     tags: [Quota]
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The pack.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/QuotaPackResponse' } } }
 *       404:
 *         description: No active pack with that uid.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.get('/packs/:uid', optionalAuth, rateLimiter.publicTiered, controller.getPack);

/**
 * @swagger
 * /quota/packs/{uid}/purchase:
 *   post:
 *     summary: Buy a top-up pack
 *     description: >
 *       Creates a Razorpay order and a `pending` grant. Confirm it exactly like any
 *       other one-time purchase — `POST /subscriptions/payment/verify` with the
 *       Checkout response, with the webhook as the source of truth. There is
 *       deliberately no separate verify endpoint for top-ups.
 *
 *
 *       The balance appears on `GET /quota/usage` once the payment is confirmed.
 *
 *
 *       The sale is refused with 409 when the top-up would buy nothing: the account
 *       has no active subscription (the feature is not metered for it), or the plan
 *       already grants that feature without limit.
 *     tags: [Quota]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Razorpay order to hand to Checkout.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/QuotaPurchaseResponse' } } }
 *       400:
 *         description: The feature is not enabled for top-ups.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       409:
 *         description: The top-up would buy nothing — no paid plan, or the plan is already unlimited.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       404:
 *         description: No active pack with that uid.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/packs/:uid/purchase', authenticate, controller.purchase);

module.exports = router;
