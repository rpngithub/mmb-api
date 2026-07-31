const cron    = require('node-cron');
const otpRepo = require('../repositories/otpCode.repository');

const job = cron.schedule('*/30 * * * *', async () => {
  console.log('[OtpCleanupJob] Running...');
  try {
    const deleted = await otpRepo.purgeExpired();
    console.log(`[OtpCleanupJob] Purged ${deleted} expired OTPs`);
  } catch (err) {
    console.error('[OtpCleanupJob] Error:', err.message);
  }
}, { scheduled: false });

module.exports = { job };
