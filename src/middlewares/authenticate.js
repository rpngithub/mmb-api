const { verifyToken } = require('../utils/jwtHelper');
const tokenBlacklistRepo = require('../repositories/tokenBlacklist.repository');
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
}

module.exports = authenticate;
