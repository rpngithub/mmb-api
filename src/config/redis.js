const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect:          true,
  enableOfflineQueue:   false,
  maxRetriesPerRequest: 3,
  retryStrategy:        (times) => Math.min(times * 100, 3000),
});

let available = false;
redis.on('ready', () => { available = true; console.log('[Redis] Connected'); });
redis.on('end',   () => { available = false; });
// Only surface errors once we've actually been connected, to avoid startup spam
// when Redis is intentionally absent in local dev.
redis.on('error', (err) => { if (available) console.error('[Redis] error:', err.message); });

redis.isAvailable = () => available;

// Probe Redis once at startup. Resolves true if reachable within the timeout,
// false otherwise — and on failure stops reconnect attempts so the app can run
// with an in-memory rate limiter instead of crashing.
redis.tryConnect = () => new Promise((resolve) => {
  let settled = false;
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    if (!ok) { try { redis.disconnect(); } catch { /* noop */ } }
    resolve(ok);
  };
  redis.once('ready', () => finish(true));
  redis.once('error', () => finish(false));
  setTimeout(() => finish(false), 2000);
  redis.connect().catch(() => { /* outcome handled via events/timeout */ });
});

module.exports = redis;
