/**
 * Shaped (non-model) responses for user settings and the business brand palette.
 *
 * @swagger
 * components:
 *   schemas:
 *     UserPreferences:
 *       type: object
 *       properties:
 *         languages:
 *           type: array
 *           description: >-
 *             CONTENT languages — which templates the user is shown, not the app's UI
 *             language. Always populated: a user who has never chosen falls back to the
 *             default set.
 *           items: { $ref: '#/components/schemas/Language' }
 *         languages_are_default:
 *           type: boolean
 *           description: >-
 *             true when the user has not actually chosen yet and is seeing the fallback.
 *             Prompt them rather than rendering a filled-in screen.
 *         notify_push:     { type: boolean }
 *         notify_email:    { type: boolean }
 *         notify_whatsapp: { type: boolean }
 *
 *     UserPreferencesResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data: { $ref: '#/components/schemas/UserPreferences' }
 *
 *     SessionActionResponse:
 *       description: Returned by the endpoints that end sessions (set password, revoke others, deactivate).
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: object
 *           properties:
 *             message:        { type: string }
 *             sessions_ended: { type: integer, description: How many sessions were revoked }
 *
 *     BrandColor:
 *       type: object
 *       required: [hex]
 *       properties:
 *         hex:
 *           type: string
 *           pattern: '^#[0-9a-fA-F]{6}$'
 *           example: '#1A2B3C'
 *           description: Full 6-digit form only; stored upper-cased, so #ff0000 and #FF0000 are one colour.
 *         label: { type: string, maxLength: 50, example: Brand Red }
 *
 *     BrandColorListResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         data:
 *           type: array
 *           description: Ordered — the first colour is the primary. Always an array, `[]` when unset.
 *           items: { $ref: '#/components/schemas/BrandColor' }
 */
