/**
 * @swagger
 * components:
 *   schemas:
 *     SendOtpRequest:
 *       type: object
 *       required: [phone, purpose]
 *       properties:
 *         phone:   { type: string, example: "+919876543210" }
 *         purpose: { type: string, enum: [login, reset] }
 *
 *     SendOtpResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           properties:
 *             message: { type: string, example: "OTP sent successfully" }
 *             otp:     { type: string, example: "482910", description: "Only present in development and staging" }
 *
 *     VerifyOtpRequest:
 *       type: object
 *       required: [phone, otp, purpose, client_mnemonic]
 *       properties:
 *         phone:           { type: string }
 *         otp:             { type: string, minLength: 6, maxLength: 6 }
 *         purpose:         { type: string, enum: [login, reset] }
 *         client_mnemonic: { type: string }
 *
 *     AuthResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           properties:
 *             access_token:  { type: string }
 *             refresh_token: { type: string }
 *             is_new_user:   { type: boolean, description: "true while onboarding is unfinished — i.e. show the personalization flow. Shorthand for !onboarding.completed." }
 *             onboarding:
 *               type: object
 *               description: "Where the signup flow stands, so the app resumes on the right screen."
 *               properties:
 *                 account_type: { type: string, enum: [business, personal], nullable: true, description: "null = step 2 not answered yet" }
 *                 has_business: { type: boolean, description: "BUSINESS accounts only — false while still in the industry picker" }
 *                 completed:    { type: boolean }
 *
 *   responses:
 *     ValidationError:
 *       description: Validation failed
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               success: { type: boolean, example: false }
 *               error:
 *                 type: object
 *                 properties:
 *                   code:    { type: string, example: VALIDATION_ERROR }
 *                   message: { type: string }
 *                   details: { type: array, items: { type: object } }
 *
 *     Unauthorized:
 *       description: Unauthorized
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               success: { type: boolean, example: false }
 *               error:
 *                 type: object
 *                 properties:
 *                   code:    { type: string, example: UNAUTHORIZED }
 *                   message: { type: string }
 *
 *     RateLimitError:
 *       description: Too many requests
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               success: { type: boolean, example: false }
 *               error:
 *                 type: object
 *                 properties:
 *                   code:    { type: string, example: RATE_LIMIT_EXCEEDED }
 *                   message: { type: string }
 */
