const { verifyToken }    = require('../utils/jwtHelper');
const tokenBlacklistRepo = require('../repositories/tokenBlacklist.repository');

/**
 * Public-endpoint authentication. Unlike `authenticate`, a missing or invalid
 * token is NOT an error — the request simply proceeds as a guest (req.user
 * stays undefined). A valid, non-revoked token populates req.user so downstream
 * handlers can adapt (premium unlock, higher rate-limit tier).
 */
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();

  const token = header.slice(7);
  try {
    const payload     = verifyToken(token);
    const blacklisted = await tokenBlacklistRepo.isBlacklisted(payload.jti);
    if (!blacklisted) req.user = payload;
  } catch {
    // invalid/expired token -> treat as guest, do not block public access
  }
  next();
}

module.exports = optionalAuth;
