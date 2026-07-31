const cron        = require('node-cron');
const subRepo     = require('../repositories/userSubscription.repository');
const quotaRepo   = require('../repositories/userQuotaUsage.repository');

async function processExpiredSubscriptions() {
  const expired = await subRepo.findExpired();

  for (const sub of expired) {
    await subRepo.update(sub.id, { status: 'expired' });

    const overridden = await subRepo.findOverriddenToReactivate(sub.user_id);
    if (overridden.length > 0) {
      await subRepo.update(overridden[0].id, { status: 'active' });
    }
  }

  if (expired.length > 0) {
    console.log(`[RenewalJob] Expired ${expired.length} subscriptions`);
  }
}

const job = cron.schedule('0 * * * *', async () => {
  console.log('[RenewalJob] Running...');
  try { await processExpiredSubscriptions(); }
  catch (err) { console.error('[RenewalJob] Error:', err.message); }
}, { scheduled: false });

module.exports = { job };
