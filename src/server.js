require('dotenv').config({ path: `.env.${process.env.NODE_ENV || 'development'}` });

const http       = require('http');
const { sequelize } = require('./models');
const redis      = require('./config/redis');
const runPendingMigrations = require('./db/runPendingMigrations');

const trendingJob     = require('./jobs/trendingScore.job');
const renewalJob      = require('./jobs/subscriptionRenewal.job');
const tokenCleanupJob = require('./jobs/tokenCleanup.job');
const otpCleanupJob   = require('./jobs/otpCleanup.job');
const quotaEventCleanupJob = require('./jobs/quotaEventCleanup.job');
const accountPurgeJob      = require('./jobs/accountPurge.job');
const notifyDispatchJob    = require('./jobs/notificationDispatch.job');
const notifyScheduledJob   = require('./jobs/notificationScheduled.job');
const notifyBehavioralJob  = require('./jobs/notificationBehavioral.job');
const notifyCleanupJob     = require('./jobs/notificationCleanup.job');

const PORT = process.env.PORT || 3000;

let server;

async function start() {
  await sequelize.authenticate();
  console.log('[DB] Connected to MySQL');

  // Bring the schema up to date before serving traffic. Gated by an env var so
  // you choose which environments auto-migrate (turn it on in staging/prod;
  // leave it off locally and keep using `npm run migrate`). An advisory lock
  // inside makes this safe when multiple instances boot at once. A broken
  // migration aborts startup on purpose — better than serving on a half-applied
  // schema. See src/db/runPendingMigrations.js.
  if (process.env.RUN_MIGRATIONS_ON_BOOT === 'true') {
    console.log('[Migrate] Checking for pending migrations on boot...');
    await runPendingMigrations();
    console.log('[Migrate] Schema up to date.');
  }

  // Announced loudly on purpose. A suspended limit is meant to be temporary, and
  // the way that goes wrong is nobody remembering it is still off months later —
  // so it says so on every boot, with the variable to unset.
  const relaxed = [...require('./config/quota').relaxedFeatures()];
  if (relaxed.length) {
    console.warn(`[Quota] ENFORCEMENT SUSPENDED for: ${relaxed.join(', ')} — usage is still being recorded. Unset QUOTA_RELAXED_FEATURES to restore limits.`);
  }

  // Redis is optional: if it's not reachable we continue with an in-memory rate
  // limiter (fine for a single instance; use Redis when running multiple).
  const redisOk = await redis.tryConnect();
  if (!redisOk) {
    console.warn('[Redis] Not connected — using in-memory rate limiting (single-instance only)');
  }

  // Require the app AFTER the Redis probe so rate limiters select the right
  // store (Redis when available, in-memory otherwise).
  const app = require('./app');
  server = http.createServer(app);

  trendingJob.job.start();
  renewalJob.job.start();
  tokenCleanupJob.job.start();
  otpCleanupJob.job.start();
  quotaEventCleanupJob.job.start();
  // Deletes self-deactivated accounts once their grace period is up. Advisory-
  // locked like the notification jobs below; see jobs/accountPurge.job.js.
  accountPurgeJob.job.start();

  // The notification jobs. Unlike the six above they are pinned to Asia/Kolkata,
  // because a user-visible notification has to land at 09:00 local regardless of
  // the container's clock, and they coordinate across instances with a MySQL
  // advisory lock (see services/notificationJobRunner.js). NOTIFY_JOBS_ENABLED=false
  // is the kill switch — the jobs still tick, and each one immediately stands down.
  notifyDispatchJob.job.start();
  notifyScheduledJob.job.start();
  notifyBehavioralJob.job.start();
  notifyCleanupJob.job.start();

  if (!require('./config/notifications').jobsEnabled()) {
    console.warn('[Notify] NOTIFY_JOBS_ENABLED=false — scheduled and behavioural notifications are SUSPENDED. Event-triggered notifications still send.');
  }

  console.log('[Jobs] All cron jobs started');

  server.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT} (${process.env.NODE_ENV})`);
  });
}

start().catch((err) => {
  console.error('[Startup] Fatal error:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
  if (server) server.close(() => process.exit(1));
  else process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received. Shutting down gracefully...');
  const done = () => {
    sequelize.close();
    if (redis.isAvailable()) redis.disconnect();
    process.exit(0);
  };
  if (server) server.close(done);
  else done();
});
