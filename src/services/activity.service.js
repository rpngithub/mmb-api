const { ActivityLog } = require('../models');

// Writes an audit-trail row. Best-effort: a logging failure must never break
// the request that triggered it.
async function log(req, { action, entityType = null, entityId = null, metadata = null }) {
  try {
    await ActivityLog.create({
      actor_type:  req.user?.actor_type || null,
      actor_id:    req.user?.userId || null,
      entity_type: entityType,
      entity_id:   entityId,
      action,
      metadata,
      ip_address:  req.ip,
    });
  } catch (err) {
    console.error('[activity.log] failed:', err.message);
  }
}

module.exports = { log };
