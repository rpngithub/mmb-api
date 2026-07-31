require('dotenv').config({ path: `.env.${process.env.NODE_ENV || 'development'}` });

const http       = require('http');
const { sequelize } = require('./models');
const redis      = require('./config/redis');
const runPendingMigrations = require('./db/runPendingMigrations');

const trendingJob     = require('./jobs/trendingScore.job');
const renewalJob      = require('./jobs/subscriptionRenewal.job');
const tokenCleanupJob = require('./jobs/tokenCleanup.job');
const otpCleanupJob   = require('./jobs/otpCleanup.job');

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
