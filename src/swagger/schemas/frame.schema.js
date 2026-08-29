/**
 * Hand-written shape for buying a frame. Not a model row — it is a Razorpay order
 * assembled per request, so it cannot come from modelSchemas.
 *
 * @swagger
 * components:
 *   schemas:
 *     FramePurchaseResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           properties:
 *             type:
 *               type: string
 *               enum: [one_time, already_owned]
 *               description: >-
 *                 `one_time` is a live order to check out. `already_owned` means the
 *                 frame had been bought and later removed, so it was simply put back
 *                 on the shelf — there is nothing to pay and no other field is set.
 *             order_id:
 *               type: string
 *               description: Razorpay order id to hand to Checkout.
 *             amount:
 *               type: number
 *               description: Total payable INCLUDING GST. The frame's stored `price` is pre-tax.
 *             currency: { type: string, example: INR }
 *             payment_uid:
 *               type: string
 *               format: uuid
 *               description: >-
 *                 The pending payment. Confirm it through POST /subscriptions/verify-payment —
 *                 frames deliberately reuse that endpoint rather than adding a second one, so
 *                 there is exactly one place a Checkout callback is verified.
 *             frame_uid: { type: string, format: uuid }
 */
