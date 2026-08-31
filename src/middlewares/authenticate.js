const { verifyToken } = require('../utils/jwtHelper');
const tokenBlacklistRepo = require('../repositories/tokenBlacklist.repository');
const touchActivity = require('./touchActivity');
const { AuthError } = require('../errors');

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new AuthError('No token provided'));
  }

  const token = header.slice(7);
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return next(new AuthError('Invalid or expired token'));
  }

  const blacklisted = await tokenBlacklistRepo.isBlacklisted(payload.jti);
  if (blacklisted) return next(new AuthError('Token has been revoked'));

  req.user = payload;
  next();

  // AFTER next(), deliberately: this is a throttled, fire-and-forget stamp of
  // users.last_active_at that the retention notifications read. It must never add
  // latency to the request or be able to fail it. See middlewares/touchActivity.js.
  touchActivity(payload);
}

module.exports = authenticate;
