const notify = require('../services/notification.service');

// Sends one notification to the CALLER, through the real dispatch path.
//
// It deliberately does not insert straight into user_notifications. Going through
// dispatch() means this doubles as the diagnostic for "why didn't my notification
// show up?" — the response reports the gate that stopped it (`daily_cap`,
// `marketing_opt_out`, `category_muted`, `render_failed`, …) instead of silently
// succeeding and telling you nothing.
//
// Each call uses a fresh dedupe key, so it can be run repeatedly to fill an inbox;
// that is the one thing about it that is not like a real send.
// Defaults are applied HERE, not by the Joi schema. middlewares/validate.js checks
// `error` and discards Joi's coerced value, so `.default()` in a schema never
// reaches req.body — an empty body would otherwise send `code: undefined` into a
// WHERE clause and 500.
const DEFAULT_CODE = 'payment_failed';

const testNotification = async (req, res) => {
  const code      = req.body.code || DEFAULT_CODE;
  const variables = req.body.variables || {};

  const result = await notify.dispatch({
    code,
    userId: req.user.userId,
    variables,
    dedupeKey: `devtest:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
  });

  res.json({
    success: true,
    data: {
      code,
      delivered: Boolean(result.created),
      // Null when it was delivered; otherwise the reason the engine passed it over.
      skipped_reason: result.skipped,
      notification: result.created
        ? {
          uid:    result.created.uid,
          title:  result.created.title,
          body:   result.created.body,
          status: result.created.status,
          // 'scheduled' means quiet hours held it back — it will appear in the
          // inbox at deliver_at, not now.
          deliver_at: result.created.deliver_at,
        }
        : null,
    },
  });
};

module.exports = { testNotification };
