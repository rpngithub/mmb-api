const cron = require('node-cron');
const { runJob } = require('../services/notificationJobRunner');
const campaigns  = require('../services/notificationCampaign.service');

// The fast tick. Two jobs, both of which need to react in minutes rather than
// hours:
//
//   1. Release notifications that were held back by quiet hours and are now due.
//      They were INSERTED at decision time with a future deliver_at, so a retry of
//      the same trigger could not queue a second copy; this makes them visible.
//   2. Drain campaign fan-out. A campaign over 100k users cannot be written in one
//      tick, so each pass moves it forward by a bounded number of batches and
//      persists a cursor.
//
// Every 5 minutes: fast enough that "send now" feels immediate and a 09:00 release
// lands within five minutes of nine, cheap enough that an idle instance does
// almost nothing (two indexed queries that match nothing).
async function runOnce(now = new Date()) {
  const released = await campaigns.releaseScheduled(now);
  const tick     = await campaigns.runDispatchTick(now);

  return {
    scanned:  released + tick.campaigns,
    inserted: tick.inserted,
    skipped:  tick.skipped,
  };
}

const job = cron.schedule('*/5 * * * *', () => runJob('dispatch', runOnce),
  { scheduled: false, timezone: 'Asia/Kolkata' });

module.exports = { job, runOnce };
