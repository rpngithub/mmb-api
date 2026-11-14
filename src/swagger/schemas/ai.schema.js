/**
 * Shapes for AI operations and jobs. None of them names a provider or a model —
 * the app is deliberately kept unaware of who fulfils a request.
 *
 * @swagger
 * components:
 *   schemas:
 *     AiOperation:
 *       type: object
 *       properties:
 *         key: { type: string, example: image.standard, description: 'Stable id, used in POST /ai/operations/{key}' }
 *         label: { type: string, example: AI image }
 *         description: { type: string, nullable: true }
 *         credits:
 *           type: integer
 *           description: >-
 *             Base price in AI credits for ONE unit. The real charge for a request is
 *             computed by the server from `price_rules` — call /estimate to show it.
 *         unit:
 *           type: string
 *           enum: [call, image, text]
 *           description: '`text` operations (captions, titles, hashtags) answer in `result.text`, not files'
 *         input_schema:
 *           type: object
 *           description: >-
 *             `{ fields: { <name>: { type, required?, min?, max?, values?, default? } }, context?: [..] }`.
 *             Types: string, enum, integer, boolean, media (one upload uid), media_list
 *             (array of upload uids), project (the uid of one of the user's own projects;
 *             someone else's is 404 AI_INPUT_NOT_FOUND). Media must be the user's own images
 *             from the media library (or earlier AI results) — upload first, then pass the
 *             `uid`. `context: ["business", "project"]` means the server adds the user's
 *             business profile and the project's design (and its thumbnail) itself — the app
 *             never sends those details.
 *         price_rules:
 *           type: object
 *           description: '`{ units_from?: "<integer field>", multipliers?: { <enum field>: { <value>: number } } }`'
 *         available:
 *           type: boolean
 *           description: false when the user's current plan does not include this operation — show it locked with an upgrade prompt
 *         plans:
 *           type: array
 *           description: The plans that include this operation. Empty = every plan (Free included).
 *           items:
 *             type: object
 *             properties:
 *               uid: { type: string, format: uuid }
 *               name: { type: string, example: Elite Plan }
 *               plan_type: { type: string, example: subscription }
 *
 *     AiJobFile:
 *       type: object
 *       properties:
 *         media_uid: { type: string, format: uuid, description: The file in the media library (slot ai_result) }
 *         s3_key: { type: string, description: Prepend cdn_base_url (GET /config) to render }
 *         url: { type: string, nullable: true, description: 'cdn_base_url + s3_key, or null when cdn_base_url is not set' }
 *         mime: { type: string, example: image/png }
 *         width: { type: integer, nullable: true }
 *         height: { type: integer, nullable: true }
 *
 *     AiJob:
 *       type: object
 *       properties:
 *         uid: { type: string, format: uuid }
 *         operation_key: { type: string }
 *         status:
 *           type: string
 *           enum: [queued, sending, processing, unknown, done, failed]
 *           description: >-
 *             Poll until `done` or `failed`. queued / sending / processing / unknown all mean
 *             "still working" to the app.
 *         credits_charged: { type: integer }
 *         refunded: { type: boolean, description: true on every failed job — the credits are back }
 *         error:
 *           type: object
 *           nullable: true
 *           properties:
 *             code: { type: string, enum: [MODERATION_BLOCKED, INVALID_INPUT, AI_UNAVAILABLE, AI_TIMEOUT, AI_FAILED] }
 *             message: { type: string }
 *         result:
 *           type: object
 *           nullable: true
 *           properties:
 *             files:
 *               type: array
 *               items: { $ref: '#/components/schemas/AiJobFile' }
 *               description: Image results, copied to our storage. Empty for a text operation.
 *             text:
 *               type: object
 *               nullable: true
 *               description: >-
 *                 A text operation's answer, shaped by the operation (e.g. social posts:
 *                 `{ options: [ { caption, hashtags[], title?, alt_text? } ] }`). Stored on the
 *                 job, not in the media library, and uses no storage. null for image operations.
 *               example: { options: [ { caption: 'Diwali offers are here!', hashtags: ['#diwali'] } ] }
 *         created_at: { type: string, format: date-time }
 *         completed_at: { type: string, format: date-time, nullable: true }
 *
 *     AiJobResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data: { $ref: '#/components/schemas/AiJob' }
 */
