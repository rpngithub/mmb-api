/**
 * Hand-written shape for buying a variant. Not a model row — it is a Razorpay order
 * assembled per request, so it cannot come from modelSchemas.
 *
 * @swagger
 * components:
 *   schemas:
 *     VariantPurchaseResponse:
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
 *               description: Total payable INCLUDING GST. The variant's stored `price` is pre-tax.
 *             currency: { type: string, example: INR }
 *             payment_uid:
 *               type: string
 *               format: uuid
 *               description: >-
 *                 The pending payment. Confirm it through POST /subscriptions/verify-payment —
 *                 the same endpoint plans, frames and top-ups use.
 *             variant_uid: { type: string, format: uuid }
 */
