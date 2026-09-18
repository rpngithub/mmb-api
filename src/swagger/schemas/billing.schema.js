/**
 * Hand-written shape for the Billing & Payments history row. It is a payment
 * row PLUS a description resolved from whatever the payment bought (plan and
 * cycle, top-up pack, frame), so it cannot come from modelSchemas.
 *
 * @swagger
 * components:
 *   schemas:
 *     PaymentHistoryRow:
 *       type: object
 *       properties:
 *         uid: { type: string, format: uuid }
 *         description:
 *           type: string
 *           example: Premium – Monthly Plan
 *           description: What was bought. "<Plan> – Monthly|Annual Plan", "<Plan> – Access Pass", "<Pack> – Top-up" or "Frame – <name>".
 *         purchase_type: { type: string, enum: [subscription, frame, quota_pack] }
 *         order_type:    { type: string, enum: [subscription, one_time], description: 'How it was billed — recurring charge or a one-time order' }
 *         date:
 *           type: string
 *           format: date-time
 *           description: paid_at for a successful payment, otherwise when the attempt was created.
 *         amount:            { type: number, description: 'Charged total, GST inclusive' }
 *         amount_before_tax: { type: number }
 *         gst_amount:        { type: number }
 *         currency:          { type: string, example: INR }
 *         status:            { type: string, enum: [pending, success, failed, refunded] }
 *         payment_method:
 *           type: string
 *           nullable: true
 *           enum: [upi, card, netbanking, wallet, emi, other]
 *           description: Reported by the Razorpay webhook; null until it lands.
 *         payment_method_detail: { type: string, nullable: true, example: 'VISA •• 4242' }
 *         invoice_number:        { type: string, nullable: true, example: MMB/2026-27/000042 }
 *         razorpay_payment_id:   { type: string, nullable: true }
 *         documents_available:
 *           type: boolean
 *           description: True only for a successful payment — the row the Invoice/Receipt buttons apply to.
 */
