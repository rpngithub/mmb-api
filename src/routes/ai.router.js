const express      = require('express');
const router       = express.Router();
const controller   = require('../controllers/ai.controller');
const authenticate = require('../middlewares/authenticate');

/**
 * @swagger
 * tags:
 *   - name: AI
 *     description: >
 *       AI features (image generation, background removal, …), charged in AI credits
 *       from the same wallet GET /quota/usage reports.
 *
 *
 *       Every request is a JOB: submit returns 202 with a job, and the app polls
 *       GET /ai/jobs/{uid} until it is `done` (files are in the media library) or
 *       `failed` (credits refunded). Credits are taken at submit, so a balance can
 *       never be overspent by firing many requests at once, and given back
 *       automatically when a job fails.
 *
 *
 *       Send an `Idempotency-Key` header (a fresh UUID per user action, reused on
 *       retry): a retried request then returns the original job instead of charging
 *       twice.
 */

router.use(authenticate);

/**
 * @swagger
 * /ai/operations:
 *   get:
 *     summary: The AI catalogue
 *     description: >
 *       Active operations, in display order. Never hardcode prices — they are admin
 *       data and can change; use /estimate for the price of a specific request.
 *     tags: [AI]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Operations.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { type: array, items: { $ref: '#/components/schemas/AiOperation' } }
 */
router.get('/operations', controller.listOperations);

/**
 * @swagger
 * /ai/operations/{key}/estimate:
 *   post:
 *     summary: What a request would cost, without charging
 *     tags: [AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string }, example: image.standard }
 *     requestBody:
 *       content: { application/json: { schema: { type: object, example: { prompt: 'A diwali sale banner', num_images: 2 } } } }
 *     responses:
 *       200:
 *         description: '`{ key, credits }`'
 *       400: { description: Input does not match the operation's input_schema (VALIDATION_ERROR) }
 *       404: { description: AI_OPERATION_NOT_FOUND }
 */
router.post('/operations/:key/estimate', controller.estimate);

/**
 * @swagger
 * /ai/operations/{key}:
 *   post:
 *     summary: Run an AI operation (charges credits, returns a job)
 *     description: >
 *       The body is the operation's own input (see its `input_schema`). Unknown
 *       fields are ignored — the price is always computed by the server.
 *
 *
 *       Errors before anything is charged: VALIDATION_ERROR (400),
 *       AI_IDEMPOTENCY_KEY_REQUIRED (400), QUOTA_EXCEEDED (402 — offer the credit
 *       packs), AI_PLAN_REQUIRED (403 — the user's plan does not include this operation;
 *       `error.details[].plan_uid` / `plan_name` are the plans that do), AI_NOT_IN_PLAN
 *       (403 — no AI credits allowance at all), AI_OPERATION_NOT_FOUND
 *       (404), AI_INPUT_NOT_FOUND (404 — an image uid that is not yours),
 *       AI_IDEMPOTENCY_KEY_REUSED (409 — same key, different request), AI_TOO_MANY_JOBS
 *       (429 — wait for one to finish), AI_MODERATION_COOLDOWN (429), AI_UNAVAILABLE (503).
 *     tags: [AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string }, example: image.standard }
 *       - { in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 8, maxLength: 64 }, description: 'A UUID per user action, reused on retry' }
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, example: { prompt: 'A diwali sale banner for a sweet shop', aspect_ratio: '1:1' } } } }
 *     responses:
 *       202:
 *         description: Charged and queued. Poll GET /ai/jobs/{uid}.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AiJobResponse' } } }
 *       200:
 *         description: Replay — this Idempotency-Key already created this job. Nothing new was charged.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AiJobResponse' } } }
 *       402:
 *         description: Not enough AI credits.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
 */
router.post('/operations/:key', controller.submit);

/**
 * @swagger
 * /ai/jobs:
 *   get:
 *     summary: The user's AI jobs, newest first
 *     tags: [AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string }, description: 'Comma-separated, e.g. done,failed' }
 *       - { in: query, name: limit, schema: { type: integer, default: 20, maximum: 100 } }
 *       - { in: query, name: offset, schema: { type: integer, default: 0 } }
 *     responses:
 *       200:
 *         description: Jobs; `meta.total` is the full count.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { type: array, items: { $ref: '#/components/schemas/AiJob' } }
 */
router.get('/jobs', controller.listJobs);

/**
 * @swagger
 * /ai/jobs/{uid}:
 *   get:
 *     summary: One AI job — poll this until done or failed
 *     description: >
 *       Back off while polling (1 s, 2 s, then every 5 s). A failed job carries
 *       `error.code` (MODERATION_BLOCKED, INVALID_INPUT, AI_UNAVAILABLE, AI_TIMEOUT,
 *       AI_FAILED) and `refunded: true`.
 *     tags: [AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: uid, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: The job.
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AiJobResponse' } } }
 *       404: { description: Not found, or not yours }
 */
router.get('/jobs/:uid', controller.getJob);

module.exports = router;
