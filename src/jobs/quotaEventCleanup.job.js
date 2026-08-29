const cron      = require('node-cron');
const eventRepo = require('../repositories/quotaUsageEvent.repository');
const quota     = require('../services/quota.service');

// quota_usage_events grows with every spend and never shrinks on its own. It only
// has to answer "this cycle" for the Usage screen, plus enough history to settle a
// billing question, so 13 months keeps a full year-over-year view and nothing more.
//
// Pruning is safe because nothing is DERIVED from the stream: the counters and the
// grant balances are the source of truth, and the events are only ever read in
// aggregate for the breakdown.
const RETENTION_MONTHS = 13;

const job = cron.schedule('30 3 * * *', async () => {
  console.log('[QuotaEventCleanupJob] Running...');
  try {
    const cutoff  = quota.addMonthsClamped(new Date(), -RETENTION_MONTHS);
    const deleted = await eventRepo.deleteOlderThan(cutoff);
    console.log(`[QuotaEventCleanupJob] Purged ${deleted} usage events older than ${cutoff.toISOString().slice(0, 10)}`);
  } catch (err) {
    console.error('[QuotaEventCleanupJob] Error:', err.message);
  }
}, { scheduled: false });

module.exports = { job, RETENTION_MONTHS };
