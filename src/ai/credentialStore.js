const { Op } = require('sequelize');
const secretBox = require('../utils/secretBox');

// Where an adapter gets its provider's API key and webhook secrets.
//
//   credential_source 'db'  (default) — decrypted from ai_provider_credentials at
//                            call time, then cached in memory for CACHE_MS. A
//                            rotation reaches every instance within a minute with
//                            no restart.
//   credential_source 'env' — read from AI_PROVIDER_<KEY>_API_KEY /
//                            AI_PROVIDER_<KEY>_WEBHOOK_SECRET, for local dev and
//                            first boot. The variable NAME is fixed by convention
//                            and never admin-supplied: an admin who could both
//                            name the variable and set base_url could otherwise
//                            point the "API key" at DB_PASSWORD and send it to a
//                            host of their choosing.
//
// Decrypted values are never logged, never put in an error, never written to a
// job row.

const CACHE_MS = 60 * 1000;
const KINDS = ['api_key', 'webhook_secret'];

const cache = new Map();   // `${providerId}:${kind}` -> { at, value }
let clock = () => Date.now();

const aadFor = (providerKey, kind) => `${providerKey}:${kind}`;
const envName = (providerKey, kind) =>
  `AI_PROVIDER_${String(providerKey).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${kind.toUpperCase()}`;

const overlapHours = () => {
  const n = parseInt(process.env.AI_WEBHOOK_SECRET_OVERLAP_HOURS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 24;
};

function decryptRow(row, providerKey) {
  return secretBox.decrypt({
    ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, version: row.master_key_version,
  }, aadFor(providerKey, row.kind));
}

async function rowsFor(provider, kind, where) {
  const { AiProviderCredential } = require('../models');
  return AiProviderCredential.unscoped().findAll({
    where: { provider_id: provider.id, kind, ...where },
    order: [['activated_at', 'DESC'], ['id', 'DESC']],
  });
}

// The active API key for a provider, or null when it has none usable (no row,
// no master key, or a row that will not decrypt).
async function apiKey(provider) {
  return cached(provider, 'api_key', async () => {
    if (provider.credential_source === 'env') return process.env[envName(provider.key, 'api_key')] || null;
    const [row] = await rowsFor(provider, 'api_key', { status: 'active' });
    if (!row) return null;
    try { return decryptRow(row, provider.key); } catch (err) {
      console.error(`[AI] ${provider.key} api_key unusable: ${err.message}`);
      return null;
    }
  });
}

// Every webhook secret a signature may currently be made with: the active one,
// plus any retired within the overlap window — in-flight webhooks can still be
// signed with the old secret for a while after a rotation.
async function webhookSecrets(provider) {
  return cached(provider, 'webhook_secret', async () => {
    if (provider.credential_source === 'env') {
      const v = process.env[envName(provider.key, 'webhook_secret')];
      return v ? [v] : [];
    }
    const since = new Date(clock() - overlapHours() * 3600 * 1000);
    const rows = await rowsFor(provider, 'webhook_secret', {
      [Op.or]: [{ status: 'active' }, { status: 'retired', retired_at: { [Op.gte]: since } }],
    });
    const out = [];
    for (const row of rows) {
      try { out.push(decryptRow(row, provider.key)); } catch (err) {
        console.error(`[AI] ${provider.key} webhook_secret ${row.uid} unusable: ${err.message}`);
      }
    }
    return out;
  });
}

async function cached(provider, kind, load) {
  const k = `${provider.id}:${kind}`;
  const hit = cache.get(k);
  if (hit && clock() - hit.at < CACHE_MS) return hit.value;
  const value = await load();
  cache.set(k, { at: clock(), value });
  return value;
}

// Encrypt and store a new credential as `pending` — the admin path (Phase 2) and
// tests. Returns the row without its secret parts.
async function addPending(provider, kind, value, { createdBy = null } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown credential kind: ${kind}`);
  const { AiProviderCredential } = require('../models');
  const box = secretBox.encrypt(value, aadFor(provider.key, kind));
  const row = await AiProviderCredential.create({
    provider_id: provider.id, kind, status: 'pending',
    ciphertext: box.ciphertext, iv: box.iv, auth_tag: box.authTag, master_key_version: box.version,
    last4: secretBox.last4(value), created_by: createdBy,
  });
  return AiProviderCredential.findByPk(row.id);
}

// pending -> active, and the previously active credential of the same kind ->
// retired, in one transaction.
async function activate(credentialId, { transaction } = {}) {
  const { AiProviderCredential, sequelize } = require('../models');
  const run = async (t) => {
    const row = await AiProviderCredential.findByPk(credentialId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row || row.status !== 'pending') return null;
    const now = new Date(clock());
    await AiProviderCredential.update(
      { status: 'retired', retired_at: now },
      { where: { provider_id: row.provider_id, kind: row.kind, status: 'active' }, transaction: t },
    );
    await row.update({ status: 'active', activated_at: now }, { transaction: t });
    return row;
  };
  const out = transaction ? await run(transaction) : await sequelize.transaction(run);
  clearCache();
  return out;
}

// active -> retired. Retiring the active API key leaves the provider without one,
// which routing then reports as `no_credential` (its operations answer
// AI_UNAVAILABLE, nothing charged) — that is the point of a manual retire.
async function retire(credentialId) {
  const { AiProviderCredential } = require('../models');
  const [n] = await AiProviderCredential.update(
    { status: 'retired', retired_at: new Date(clock()) },
    { where: { id: credentialId, status: ['active', 'pending'] } },
  );
  clearCache();
  return n === 1;
}

// One credential's plaintext, for the admin "test this key" call only — so a
// PENDING key can be verified before it is activated. Never returned to a client.
async function reveal(credentialId) {
  const { AiProviderCredential, AiProvider } = require('../models');
  const row = await AiProviderCredential.unscoped().findByPk(credentialId);
  if (!row) return null;
  const provider = await AiProvider.findByPk(row.provider_id);
  return decryptRow(row, provider.key);
}

const clearCache = () => cache.clear();
const _setClock = (fn) => { clock = fn || (() => Date.now()); };

module.exports = {
  apiKey, webhookSecrets, addPending, activate, retire, reveal, clearCache, envName, aadFor, CACHE_MS, KINDS, _setClock,
};
