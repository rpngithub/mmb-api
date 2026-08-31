const cron = require('node-cron');
const { runJob } = require('../services/notificationJobRunner');
const scans      = require('../services/notificationScans.service');

// Date-anchored notifications: "your trial ends tomorrow", "your subscription
// expires in 2 days", "Diwali is tomorrow".
//
// 09:00 IST — inside the quiet-hours window's daylight half, so these cannot
// violate quiet hours by construction rather than by remembering to check. The
// explicit timezone matters: the existing five jobs in this repo are TZ-naive
// because they are janitorial and any hour works, but a user-visible notification
// has to land at nine in the morning regardless of what the container's clock
// thinks the date is.
//
// Runs once a day even though each scan uses a multi-day window. The window is
// what makes a missed run self-healing; the dedupe key is what stops the overlap
// from double-sending.
async function runOnce(now = new Date()) {
  return scans.runScheduled(now);
}

const job = cron.schedule('0 9 * * *', () => runJob('scheduled', () => runOnce()),
  { scheduled: false, timezone: 'Asia/Kolkata' });

module.exports = { job, runOnce };
