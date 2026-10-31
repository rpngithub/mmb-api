const cron    = require('node-cron');
const otpRepo = require('../repositories/otpCode.repository');
const otpChallenge = require('../services/otpChallenge.service');

const job = cron.schedule('*/30 * * * *', async () => {
  console.log('[OtpCleanupJob] Running...');
  try {
    const deleted = await otpRepo.purgeExpired();
    // The account-bound OTPs (phone / email change) expire the same way.
    const challenges = await otpChallenge.purgeExpired();
    console.log(`[OtpCleanupJob] Purged ${deleted} expired OTPs, ${challenges} account OTPs`);
  } catch (err) {
    console.error('[OtpCleanupJob] Error:', err.message);
  }
}, { scheduled: false });

module.exports = { job };
