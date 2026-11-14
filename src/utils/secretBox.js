const crypto = require('crypto');

// Encrypts provider secrets (AI API keys, webhook secrets) for storage in the
// database. AES-256-GCM with a fresh random 96-bit IV per value, Node's built-in
// crypto only. GCM is authenticated: a tampered ciphertext, IV or tag — or a
// value moved onto a different provider/kind row (the AAD) — fails to decrypt
// instead of decrypting to garbage.
//
// The master key is the ONE secret kept out of the database:
//
//   AI_SECRETS_MASTER_KEY            base64, exactly 32 bytes
//   AI_SECRETS_MASTER_KEY_VERSION    integer, default 1; stamped on every row
//   AI_SECRETS_PREVIOUS_MASTER_KEY   only while rotating the master key: rows
//   AI_SECRETS_PREVIOUS_MASTER_KEY_VERSION   written under it still decrypt, and
//                                    scripts/ai-rekey.js re-encrypts them
//
// Nothing else in the codebase reads these variables. Errors never include the
// plaintext or the key.
//
// Read from process.env on each call (like config/quota.js) so a test can set it.

class SecretBoxError extends Error {}

function decodeKey(raw, name) {
  if (!raw) return null;
  const key = Buffer.from(String(raw).trim(), 'base64');
  if (key.length !== 32) throw new SecretBoxError(`${name} must be 32 bytes, base64-encoded`);
  return key;
}

const int = (raw, fallback) => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// { version: key } for every master key currently configured.
function keyring() {
  const ring = {};
  const current = decodeKey(process.env.AI_SECRETS_MASTER_KEY, 'AI_SECRETS_MASTER_KEY');
  if (current) ring[currentVersion()] = current;
  const previous = decodeKey(process.env.AI_SECRETS_PREVIOUS_MASTER_KEY, 'AI_SECRETS_PREVIOUS_MASTER_KEY');
  if (previous) ring[int(process.env.AI_SECRETS_PREVIOUS_MASTER_KEY_VERSION, 0)] = previous;
  return ring;
}

const currentVersion = () => int(process.env.AI_SECRETS_MASTER_KEY_VERSION, 1);

// True when a master key is configured and well-formed. Boot uses this to mark DB
// credentials unusable rather than failing on a user's first request.
function isConfigured() {
  try { return Boolean(keyring()[currentVersion()]); } catch { return false; }
}

/**
 * @param {string} plaintext
 * @param {string} aad  binds the ciphertext to its row, e.g. 'magnific:api_key'
 * @returns {{ ciphertext: Buffer, iv: Buffer, authTag: Buffer, version: number }}
 */
function encrypt(plaintext, aad) {
  if (typeof plaintext !== 'string' || !plaintext) throw new SecretBoxError('nothing to encrypt');
  const version = currentVersion();
  const key = keyring()[version];
  if (!key) throw new SecretBoxError('AI_SECRETS_MASTER_KEY is not configured');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), version };
}

/**
 * @returns {string} the plaintext
 * @throws SecretBoxError — on a missing key version or any tampering
 */
function decrypt({ ciphertext, iv, authTag, version }, aad) {
  const key = keyring()[version];
  if (!key) throw new SecretBoxError(`no master key configured for version ${version}`);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv));
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(Buffer.from(authTag));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately says nothing about why: the underlying error is the same for
    // a wrong key, a wrong AAD and a tampered byte, and none of them is the
    // caller's business beyond "this value cannot be used".
    throw new SecretBoxError('secret could not be decrypted');
  }
}

// The only part of a secret ever shown back: '••••1a2b'.
const last4 = (plaintext) => String(plaintext).slice(-4);

module.exports = { encrypt, decrypt, isConfigured, currentVersion, last4, SecretBoxError };
