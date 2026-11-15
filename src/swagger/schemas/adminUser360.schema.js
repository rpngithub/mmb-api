/**
 * Hand-written shapes for the admin User 360 endpoints (src/services/adminUser360.service.js).
 * They join several models or add computed fields, so they cannot come from modelSchemas.
 *
 * @swagger
 * components:
 *   schemas:
 *     AdminCurrentPlan:
 *       type: object
 *       nullable: true
 *       description: The user's newest ACTIVE subscription; null = free tier.
 *       properties:
 *         name:       { type: string, example: Pro }
 *         plan_type:  { type: string, enum: [subscription, access_pass, free] }
 *         sub_type:   { type: string, enum: [regular, trial, access_pass] }
 *         status:     { type: string, example: active }
 *         ends_at:    { type: string, format: date-time }
 *         auto_renew: { type: boolean }
 *     AdminUserListRow:
 *       allOf:
 *         - $ref: '#/components/schemas/User'
 *         - type: object
 *           properties:
 *             current_plan: { $ref: '#/components/schemas/AdminCurrentPlan' }
 *     AdminUserListResponse360:
 *       type: object
 *       properties:
 *         success: { type: boolean, example: true }
 *         data:    { type: array, items: { $ref: '#/components/schemas/AdminUserListRow' } }
 *         meta:    { type: object, properties: { total: { type: integer } } }
 *     AdminUserDetail:
 *       allOf:
 *         - $ref: '#/components/schemas/User'
 *         - type: object
 *           properties:
 *             has_active_subscription: { type: boolean }
 *             counts:
 *               type: object
 *               properties:
 *                 projects:        { type: integer }
 *                 downloads:       { type: integer, description: Successful download exports }
 *                 shares:          { type: integer, description: Successful share exports }
 *                 ai_jobs:         { type: integer }
 *                 businesses:      { type: integer }
 *                 active_sessions: { type: integer, description: Not revoked and not expired }
 *             billing_details:
 *               type: object
 *               nullable: true
 *               description: Present only with billing.read; null when the user saved none.
 *               properties:
 *                 billing_name:    { type: string }
 *                 gstin:           { type: string, nullable: true }
 *                 billing_address: { type: string }
 *                 billing_state:   { type: string }
 *                 billing_pincode: { type: string }
 *                 updated_at:      { type: string, format: date-time }
 *     AdminUserDetailResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean, example: true }
 *         data:    { $ref: '#/components/schemas/AdminUserDetail' }
 *     AdminUserSubscriptionRow:
 *       type: object
 *       properties:
 *         uid:          { type: string, format: uuid }
 *         status:       { type: string, enum: [pending, active, overridden, cancelled, expired] }
 *         sub_type:     { type: string, enum: [regular, trial, access_pass] }
 *         starts_at:    { type: string, format: date-time }
 *         ends_at:      { type: string, format: date-time }
 *         cancelled_at: { type: string, format: date-time, nullable: true }
 *         auto_renew:   { type: integer, enum: [0, 1] }
 *         amount_paid:  { type: string, example: '299.00' }
 *         razorpay_subscription_id: { type: string, nullable: true }
 *         created_at:   { type: string, format: date-time }
 *         updated_at:   { type: string, format: date-time }
 *         Plan:
 *           type: object
 *           properties: { uid: { type: string, format: uuid }, name: { type: string }, plan_type: { type: string } }
 *         PlanBillingOption:
 *           type: object
 *           nullable: true
 *           description: Null for an access pass.
 *           properties: { billing_cycle: { type: string, enum: [monthly, annual] }, price: { type: string }, currency: { type: string } }
 *         Coupon:
 *           type: object
 *           nullable: true
 *           properties: { code: { type: string } }
 *     AdminUserSubscriptionListResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean, example: true }
 *         data:    { type: array, items: { $ref: '#/components/schemas/AdminUserSubscriptionRow' } }
 *         meta:    { type: object, properties: { total: { type: integer } } }
 *     AdminUserPaymentRow:
 *       type: object
 *       properties:
 *         uid:                   { type: string, format: uuid }
 *         description:           { type: string, example: Pro – Monthly Plan }
 *         purchase_type:         { type: string, enum: [subscription, frame, quota_pack, variant] }
 *         order_type:            { type: string, enum: [subscription, one_time] }
 *         amount:                { type: number }
 *         amount_before_tax:     { type: number }
 *         gst_rate:              { type: number }
 *         gst_amount:            { type: number }
 *         currency:              { type: string, example: INR }
 *         status:                { type: string, enum: [pending, success, failed, refunded], description: Stored status }
 *         display_status:        { type: string, enum: [pending, success, failed, abandoned, refunded], description: What the user's Billing screen shows }
 *         payment_method:        { type: string, nullable: true, enum: [upi, card, netbanking, wallet, emi, other] }
 *         payment_method_detail: { type: string, nullable: true }
 *         invoice_number:        { type: string, nullable: true }
 *         failure_reason:        { type: string, nullable: true }
 *         razorpay_order_id:     { type: string, nullable: true }
 *         razorpay_payment_id:   { type: string, nullable: true }
 *         paid_at:               { type: string, format: date-time, nullable: true }
 *         created_at:            { type: string, format: date-time }
 *         has_invoice:           { type: boolean, description: True only for a successful payment }
 *     AdminUserPaymentListResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean, example: true }
 *         data:    { type: array, items: { $ref: '#/components/schemas/AdminUserPaymentRow' } }
 *         meta:    { type: object, properties: { total: { type: integer } } }
 *     AdminUserBusinessRow:
 *       type: object
 *       properties:
 *         uid:               { type: string, format: uuid }
 *         name:              { type: string }
 *         description:       { type: string, nullable: true }
 *         logo_s3_key:       { type: string, nullable: true }
 *         BusinessCategory:  { type: object, nullable: true, properties: { uid: { type: string, format: uuid }, name: { type: string } } }
 *         address:           { type: string, nullable: true }
 *         city:              { type: string, nullable: true }
 *         state:             { type: string, nullable: true }
 *         phone:             { type: string, nullable: true }
 *         whatsapp:          { type: string, nullable: true }
 *         email:             { type: string, nullable: true }
 *         website:           { type: string, nullable: true }
 *         rating_avg:        { type: string, example: '4.5' }
 *         rating_count:      { type: integer }
 *         is_active:         { type: integer }
 *         watermark_enabled: { type: integer }
 *         activeFrame:       { type: object, nullable: true, properties: { uid: { type: string, format: uuid }, name: { type: string } } }
 *         variants:
 *           type: array
 *           description: Brand-series variants the business has in use
 *           items: { type: object, properties: { uid: { type: string, format: uuid }, name: { type: string } } }
 *         created_at:        { type: string, format: date-time }
 *     AdminUserBusinessListResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean, example: true }
 *         data:    { type: array, items: { $ref: '#/components/schemas/AdminUserBusinessRow' } }
 *     AdminUserProjectRow:
 *       type: object
 *       properties:
 *         uid:              { type: string, format: uuid }
 *         name:             { type: string }
 *         project_type:     { type: string, enum: [image, video] }
 *         status:           { type: string, enum: [draft, published, archived] }
 *         thumbnail_s3_key: { type: string, nullable: true }
 *         Template:         { type: object, nullable: true, properties: { uid: { type: string, format: uuid }, name: { type: string } } }
 *         Business:         { type: object, nullable: true, properties: { uid: { type: string, format: uuid }, name: { type: string } } }
 *         export_count:     { type: integer, description: Downloads + shares of this design }
 *         created_at:       { type: string, format: date-time }
 *         updated_at:       { type: string, format: date-time }
 *     AdminUserProjectListResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean, example: true }
 *         data:    { type: array, items: { $ref: '#/components/schemas/AdminUserProjectRow' } }
 *         meta:    { type: object, properties: { total: { type: integer } } }
 */
