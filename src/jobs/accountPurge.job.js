const cron  = require('node-cron');
const purge = require('../services/accountPurge.service');
const { withAdvisoryLock, NOT_ACQUIRED } = require('../utils/advisoryLock');

// Deletes the data of accounts whose self-deactivation grace period has run out.
// See services/accountPurge.service.js for what is deleted, what the tombstone
// keeps, and why Razorpay is stopped first.
//
// Hourly is plenty: the grace period is measured in hours (admin-tunable,
// default 24) and nobody is waiting on the exact minute. Advisory-locked so that
// with several instances only one runs the sweep — a second one would list the
// same accounts and the two would race through the same DELETEs. The purge is
// idempotent per account, so even a lost lock is only wasted work, never damage.
const LOCK = 'mmb_account_purge';

const job = cron.schedule('15 * * * *', async () => {
  try {
    const result = await withAdvisoryLock(LOCK, 0, () => purge.runOnce());
    if (result === NOT_ACQUIRED) return;
    if (result.due) console.log(`[AccountPurge] due ${result.due}, purged ${result.purged}, failed ${result.failed}`);
  } catch (err) {
    console.error('[AccountPurge] Error:', err.message);
  }
}, { scheduled: false });

module.exports = { job };
