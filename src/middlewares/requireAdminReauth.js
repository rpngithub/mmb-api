const bcrypt = require('bcryptjs');
const AppError = require('../errors/AppError');

// Step-up confirmation for the most sensitive admin actions — setting, activating
// or retiring an AI provider key, or pointing a provider at a different host. A
// valid admin session is not enough on its own: a stolen admin token, or a laptop
// left unlocked, must not be able to swap our provider key for one an attacker
// controls (or send ours to their host).
//
// The admin re-types their password in the `X-Admin-Password` header. Never logged
// (morgan does not log request headers) and never echoed back.
//
// 403 rather than 401 on a mismatch, on purpose: the admin panel treats 401 as
// "session expired" and logs the admin out — the wrong reaction to a typo.
//
// Failed attempts are throttled per admin (in memory: one instance, see the Redis
// memory note) so the header cannot be used to brute-force a password from an
// already-authenticated session.

const MAX_FAILURES = 5;
const WINDOW_MS    = 15 * 60 * 1000;
const failures = new Map();   // admin id -> [timestamps]

const recent = (id, now) => (failures.get(id) || []).filter((t) => now - t < WINDOW_MS);

async function requireAdminReauth(req, res, next) {
  const { AdminUser } = require('../models');
  const id  = req.user?.userId;
  const now = Date.now();

  if (recent(id, now).length >= MAX_FAILURES) {
    return next(new AppError('Too many failed password confirmations. Try again later.', 429, 'REAUTH_LOCKED'));
  }

  const password = req.get('X-Admin-Password');
  if (!password) {
    return next(new AppError('Confirm your password (X-Admin-Password) to make this change', 403, 'REAUTH_REQUIRED'));
  }

  const admin = id ? await AdminUser.findByPk(id, { attributes: ['id', 'password_hash'] }) : null;
  const ok = admin ? await bcrypt.compare(password, admin.password_hash) : false;
  if (!ok) {
    failures.set(id, [...recent(id, now), now]);
    return next(new AppError('Password confirmation failed', 403, 'REAUTH_FAILED'));
  }

  failures.delete(id);
  req.reauthenticated = true;
  return next();
}

// Only when the request touches one of `fields` — e.g. a provider PATCH needs it
// for base_url / credential_source, not for a rate-limit tweak.
const requireAdminReauthIf = (fields) => (req, res, next) => (
  fields.some((f) => req.body && req.body[f] !== undefined) ? requireAdminReauth(req, res, next) : next()
);

const _resetFailures = () => failures.clear();

module.exports = requireAdminReauth;
module.exports.requireAdminReauthIf = requireAdminReauthIf;
module.exports._resetFailures = _resetFailures;
