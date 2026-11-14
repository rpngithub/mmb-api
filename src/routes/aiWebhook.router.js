const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/ai.controller');

/**
 * @swagger
 * /webhooks/ai/{provider}:
 *   post:
 *     summary: AI provider callback (server-to-server)
 *     description: >
 *       One endpoint per provider, called by the provider when a task finishes. No
 *       bearer token — the request is authenticated by the provider's signature over
 *       the raw body, checked against its webhook secret (the active one, plus any
 *       retired within AI_WEBHOOK_SECRET_OVERLAP_HOURS). Not for app use.
 *
 *
 *       Magnific (`/webhooks/ai/magnific`) signs Standard-Webhooks style: headers
 *       `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<base64>`), an
 *       HMAC-SHA256 of `id.timestamp.rawBody`. Deliveries older than 5 minutes are
 *       refused as replays.
 *
 *
 *       Answers 200 for every correctly signed call, including unknown or already
 *       finished tasks, so the provider does not retry forever; 401 on a bad
 *       signature; 404 for an unknown provider. Exempt from the global rate limiter.
 *     tags: [AI]
 *     security: []
 *     parameters:
 *       - { in: path, name: provider, required: true, schema: { type: string }, example: fake }
 *     responses:
 *       200: { description: Received (or deliberately ignored) }
 *       401: { description: Bad signature }
 *       404: { description: Unknown provider }
 */
router.post('/ai/:provider', controller.webhook);

module.exports = router;
