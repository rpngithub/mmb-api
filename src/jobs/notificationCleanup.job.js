const cron = require('node-cron');
const sequelize = require('../config/db');
const { runJob } = require('../services/notificationJobRunner');
const cfg = require('../config/notifications');

// `user_notifications` is the only table in the schema that grows per-user-per-day.
// Left alone it becomes the largest table here within a year.
//
// Pruning is safe because nothing is DERIVED from these rows except the fatigue
// counters, which look back at most seven days, and `max_occurrences` — whose
// semantics are therefore "within the retention window". That is documented
// behaviour (see notification.repository#templateHistory), not a bug: enforcing a
// true lifetime cap would need a separate counter that could drift from the rows
// it counts. The things that actually matter — payments, subscriptions, quota —
// live in their own tables; deleting the NOTIFICATION about a payment loses
// nothing.
//
// Same shape and reasoning as quotaEventCleanup.job.js.

// Bounded loops, not one giant DELETE. A multi-million-row DELETE holds locks for
// minutes and bloats the binlog; 5k x 200 is a 1M/night ceiling, which comfortably
// outruns any realistic ingest rate.
const BATCH       = 5000;
const MAX_BATCHES = 200;

function rules() {
  return [
    // Dismissed: the user has explicitly cleared it.
    { name: 'dismissed', days: cfg.retentionDismissedDays(), predicate: 'dismissed_at IS NOT NULL' },
    // Read but not dismissed.
    { name: 'read',      days: cfg.retentionReadDays(),      predicate: 'dismissed_at IS NULL AND read_at IS NOT NULL' },
    // Never opened. Kept longest — an unread notification is the one case where
    // the user might still act on it.
    { name: 'unread',    days: cfg.retentionUnreadDays(),    predicate: 'dismissed_at IS NULL AND read_at IS NULL' },
  ];
}

async function purge() {
  let deleted = 0;

  for (const rule of rules()) {
    for (let i = 0; i < MAX_BATCHES; i++) {
      // ORDER BY created_at makes this walk ix_user_notif_created rather than the
      // primary key, so each batch is a contiguous range of the oldest rows.
      //
      // No `type:` on purpose. QueryTypes.DELETE discards the driver's result, so
      // affectedRows always read as 0 — which silently capped the prune at one
      // batch per rule per night and reported "purged 0" while actually deleting
      // rows. Without a type, Sequelize hands back [rows, metadata] and mysql2's
      // OkPacket carries the real count.
      const [, meta] = await sequelize.query(
        `DELETE FROM user_notifications
          WHERE ${rule.predicate}
            AND created_at < DATE_SUB(NOW(), INTERVAL :days DAY)
          ORDER BY created_at
          LIMIT :batch`,
        { replacements: { days: rule.days, batch: BATCH } },
      );

      const n = Number(meta?.affectedRows ?? 0);
      deleted += n;
      if (n < BATCH) break;
    }
  }

  // The job-run audit itself is unbounded otherwise: four jobs x every instance,
  // several times an hour. Two weeks is far more history than "did last night's
  // scan run?" needs.
  await sequelize.query(
    'DELETE FROM notification_job_runs WHERE started_at < DATE_SUB(NOW(), INTERVAL 14 DAY)',
  );

  return deleted;
}

async function runOnce() {
  const deleted = await purge();
  return { scanned: deleted, inserted: 0, skipped: 0 };
}

const job = cron.schedule('45 3 * * *', () => runJob('cleanup', runOnce),
  { scheduled: false, timezone: 'Asia/Kolkata' });

module.exports = { job, runOnce, purge, BATCH, MAX_BATCHES };
