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
 *
 *     FrameDesignRequest:
 *       type: object
 *       required: [content]
 *       properties:
 *         content:
 *           type: string
 *           description: The edited design payload (same contract as the version's content). Up to 2 MB.
 *         thumbnail:
 *           type: string
 *           description: >-
 *             Preview as a data URL or bare base64 — JPEG, PNG or WebP, decided by the
 *             bytes; up to 500 KB decoded. Omit it to keep the current preview, so the
 *             2-second autosave can send content alone and the preview on a slower tick.
 *
 *     FrameDesignResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           properties:
 *             frame_uid:        { type: string, format: uuid }
 *             version_uid:      { type: string, format: uuid }
 *             uid:              { type: string, format: uuid, description: The edited copy }
 *             thumbnail_s3_key: { type: string, nullable: true }
 *             created_at:       { type: string, format: date-time }
 *             updated_at:       { type: string, format: date-time }
 *             original_updated:
 *               type: boolean
 *               description: The admin changed the original since this copy was made or last reset.
 */
