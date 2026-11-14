// Master-key rotation for AI provider credentials.
//
//   1. Generate a new key:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//   2. Set, on the host:
//        AI_SECRETS_PREVIOUS_MASTER_KEY          = the current key
//        AI_SECRETS_PREVIOUS_MASTER_KEY_VERSION  = the current version (e.g. 1)
//        AI_SECRETS_MASTER_KEY                   = the NEW key
//        AI_SECRETS_MASTER_KEY_VERSION           = current + 1 (e.g. 2)
//      and restart. Old rows still decrypt (with the previous key); new rows use the new one.
//   3. Run:  npm run ai:rekey            (or `node src/ai/rekey.js --dry-run` first)
//   4. When it reports 0 remaining, remove the two PREVIOUS variables and restart.
//
// One row at a time, each in its own UPDATE guarded on the version it read, so it
// is safe to stop and re-run, and safe against a concurrent admin edit. Retired
// credentials are re-encrypted too: a retired webhook secret may still be inside
// its overlap window, and leaving any row on the old key would make step 4 break it.
//
// Prints counts and credential uids only — never a value.

const secretBox = require('../utils/secretBox');
const credentialStore = require('./credentialStore');

async function rekeyAll({ dryRun = false, log = console.log } = {}) {
  const { AiProviderCredential, AiProvider } = require('../models');
  const { Op } = require('sequelize');
  const target = secretBox.currentVersion();
  const rows = await AiProviderCredential.unscoped().findAll({ where: { master_key_version: { [Op.ne]: target } } });
  const keys = new Map((await AiProvider.findAll({ attributes: ['id', 'key'] })).map((p) => [p.id, p.key]));

  let done = 0;
  const failed = [];
  for (const row of rows) {
    const aad = credentialStore.aadFor(keys.get(row.provider_id), row.kind);
    try {
      const plain = secretBox.decrypt({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, version: row.master_key_version }, aad);
      if (!dryRun) {
        const box = secretBox.encrypt(plain, aad);
        const [n] = await AiProviderCredential.unscoped().update(
          { ciphertext: box.ciphertext, iv: box.iv, auth_tag: box.authTag, master_key_version: box.version },
          { where: { id: row.id, master_key_version: row.master_key_version } },
        );
        if (n) done += 1;
      } else {
        done += 1;
      }
    } catch (err) {
      failed.push(row.uid);
      log(`  could not re-encrypt ${row.uid} (version ${row.master_key_version}): ${err.message}`);
    }
  }
  credentialStore.clearCache();
  const remaining = rows.length - (dryRun ? 0 : done);
  log(`${dryRun ? '[dry run] would re-encrypt' : 're-encrypted'} ${done} of ${rows.length} credential(s) to master key version ${target}; ${remaining} remaining${failed.length ? `; ${failed.length} failed` : ''}`);
  return { total: rows.length, done, failed, remaining };
}

if (require.main === module) {
  require('dotenv').config({ path: `.env.${process.env.NODE_ENV || 'development'}` });
  const dryRun = process.argv.includes('--dry-run');
  rekeyAll({ dryRun })
    .then(async (r) => {
      await require('../models').sequelize.close();
      process.exit(r.failed.length ? 1 : 0);
    })
    .catch((err) => { console.error(`[ai:rekey] ${err.message}`); process.exit(1); });
}

module.exports = { rekeyAll };
