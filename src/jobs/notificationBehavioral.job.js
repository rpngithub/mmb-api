const cron = require('node-cron');
const { runJob } = require('../services/notificationJobRunner');
const scans      = require('../services/notificationScans.service');

// The dormancy ladder and the setup-gap nudges, plus the recurring promotions.
//
// 09:30 IST, half an hour after the date-anchored job. The order is deliberate:
// the date-anchored notifications are the ones a user actually needs ("your trial
// ends tomorrow"), so they get first call on the daily fatigue cap. By the time
// this runs, anyone who already received something urgent this morning is inside
// the min-gap window and will be skipped — which is exactly the intended
// arbitration.
//
// This is the highest-fatigue-risk job in the feature: it is the one that can
// decide to message a large fraction of the user base in a single pass. Three
// things bound it — the narrow scan buckets (a three-day cohort, not the whole
// dormant population), the per-user daily/weekly caps, and the per-run row
// ceiling.
async function runOnce(now = new Date()) {
  const behavioral = await scans.runBehavioral();
  const recurring  = await scans.runRecurring(now);

  return {
    scanned:  behavioral.scanned  + recurring.scanned,
    inserted: behavioral.inserted + recurring.inserted,
    skipped:  behavioral.skipped  + recurring.skipped,
  };
}

const job = cron.schedule('30 9 * * *', () => runJob('behavioral', () => runOnce()),
  { scheduled: false, timezone: 'Asia/Kolkata' });

module.exports = { job, runOnce };
