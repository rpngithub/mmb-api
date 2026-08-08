const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/feedback.controller');
const authenticate = require('../middlewares/authenticate');
const rateLimiter  = require('../middlewares/rateLimiter');
const validate     = require('../middlewares/validate');
const { submitFeedbackSchema } = require('../validators/feedback.validator');

/**
 * @swagger
 * tags:
 *   - name: Feedback
 *     description: In-app feedback (signed-in users only)
 */

/**
 * @swagger
 * /feedback:
 *   post:
 *     summary: Send feedback
 *     description: >-
 *       The rating is the five faces on the Feedback screen, 1 (worst) to 5 (best), and is
 *       required; the note is optional. Signed-in users only, so every submission is
 *       attributable and support has someone to reply to. Rate limited — a burst of
 *       submissions returns 429.
 *     tags: [Feedback]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rating]
 *             properties:
 *               rating:      { type: integer, minimum: 1, maximum: 5 }
 *               message:     { type: string, maxLength: 2000 }
 *               app_version: { type: string, description: "e.g. '2.4.1' — helps support triage" }
 *               platform:    { type: string, description: "e.g. 'android', 'ios', 'web'" }
 *     responses:
 *       201:
 *         description: The recorded submission
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     uid:        { type: string, format: uuid }
 *                     rating:     { type: integer }
 *                     created_at: { type: string, format: date-time }
 *       400:
 *         description: Missing or out-of-range rating
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 *       429:
 *         description: Too many submissions
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/', authenticate, rateLimiter.feedback, validate(submitFeedbackSchema), controller.submit);

module.exports = router;
