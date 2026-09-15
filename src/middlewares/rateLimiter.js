const rateLimit  = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redis      = require('../config/redis');
const { normalizePhone } = require('../utils/phone');

const createLimiter = (options) =>
  rateLimit({
    windowMs:     options.windowMs,
    max:          options.max,
    // Use Redis when it's connected (shared across instances); otherwise fall
    // back to express-rate-limit's in-memory store (per-process).
    store:        redis.isAvailable() ? new RedisStore({ sendCommand: (...args) => redis.call(...args) }) : undefined,
    keyGenerator: options.keyGenerator || ((req) => req.ip),
    handler: (req, res) =>
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMIT_EXCEEDED', message: options.message || 'Too many requests' },
      }),
    standardHeaders: true,
    legacyHeaders:   false,
    skip: () => process.env.NODE_ENV === 'test',
  });

// Public-catalog limiters: guests are throttled hardest, logged-in users get a
// higher allowance, and paid subscribers higher still. `publicTiered` runs
// AFTER optionalAuth and dispatches to the right bucket based on req.user.tier.
const publicGuest = createLimiter({ windowMs: 60_000, max: 60,  keyGenerator: (req) => `pub:guest:${req.ip}` });
const publicFree  = createLimiter({ windowMs: 60_000, max: 150, keyGenerator: (req) => `pub:free:${req.user.userId}` });
const publicPaid  = createLimiter({ windowMs: 60_000, max: 400, keyGenerator: (req) => `pub:paid:${req.user.userId}` });

const publicTiered = (req, res, next) => {
  if (!req.user) return publicGuest(req, res, next);
  return (req.user.tier === 'paid' ? publicPaid : publicFree)(req, res, next);
};

module.exports = {
  global:  createLimiter({ windowMs: 60_000,      max: 200 }),
  guest:   createLimiter({ windowMs: 60_000,       max: 30 }),
  auth:    createLimiter({ windowMs: 15 * 60_000,  max: 10 }),
  // Feedback is a write anyone signed in can make, with no natural cost to them —
  // keyed per user rather than per IP so one account cannot flood the queue from
  // several devices, and so shared networks don't throttle each other.
  feedback: createLimiter({
    windowMs:     60 * 60_000,
    max:          5,
    message:      'Too many feedback submissions. Try again later.',
    keyGenerator: (req) => `feedback:${req.user?.userId || req.ip}`,
  }),
  otpSend: createLimiter({
    windowMs:     10 * 60_000,
    max:          3,
    message:      'Too many OTP requests. Try again in 10 minutes.',
    // Canonicalised, so +91X and X share one bucket instead of doubling the cap.
    keyGenerator: (req) => `otp:send:${req.body?.phone ? normalizePhone(req.body.phone) : req.ip}`,
  }),
  // Dev SMS diagnostics. Every call spends a real DLT credit and texts a real handset,
  // so it is capped harder than otpSend even though the route is development-only.
  smsTest: createLimiter({
    windowMs:     10 * 60_000,
    max:          5,
    message:      'Too many SMS test sends. Try again in 10 minutes.',
    keyGenerator: (req) => `sms:test:${req.ip}`,
  }),
  admin: createLimiter({
    windowMs:     60_000,
    max:          300,
    keyGenerator: (req) => `${req.ip}:${req.user?.userId || 'anon'}`,
  }),
  publicTiered,
};
