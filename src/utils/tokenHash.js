const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Refresh tokens are stored as a SHA-256 digest, not a bcrypt hash.
//
// bcrypt silently truncates its input at 72 bytes. A refresh token is a JWT, and
// its first 72 bytes are the (fixed) header plus the opening of the payload — the
// `jti`, `iat`, `exp` and the entire signature all sit beyond the cutoff. So a
// bcrypt hash of a refresh token verified any token sharing that prefix, which is
// every token this API issues to the same account. It bound almost nothing.
//
// SHA-256 covers the whole token. Bcrypt's slowness buys nothing here anyway: these
// are high-entropy random values, not guessable human passwords, so there is no
// dictionary attack to slow down — only a per-refresh cost on a host with little
// headroom.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Compares in constant time so a stored digest can't be recovered by timing the
// comparison. Rows written before the switch hold a bcrypt hash — recognisable by
// its `$2…$` prefix — and are still verified with bcrypt, so existing sessions keep
// working instead of every user being logged out by the deploy. Those rows upgrade
// themselves on their next refresh, which rewrites the hash.
async function verifyTokenHash(token, stored) {
  if (!stored) return false;

  if (stored.startsWith('$2')) return bcrypt.compare(token, stored);

  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(stored, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { hashToken, verifyTokenHash };
