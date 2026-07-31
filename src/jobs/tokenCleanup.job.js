const cron          = require('node-cron');
const blacklistRepo = require('../repositories/tokenBlacklist.repository');

const job = cron.schedule('0 3 * * *', async () => {
  console.log('[TokenCleanupJob] Running...');
  try {
    const deleted = await blacklistRepo.purgeExpired();
    console.log(`[TokenCleanupJob] Purged ${deleted} expired tokens`);
  } catch (err) {
    console.error('[TokenCleanupJob] Error:', err.message);
  }
}, { scheduled: false });

module.exports = { job };
