const appSettingRepo = require('../repositories/appSetting.repository');

// app_settings stores everything as text; `type` says how to read it back.
function cast(setting) {
  const { value, type } = setting;
  if (type === 'integer') return parseInt(value, 10);
  if (type === 'boolean') return value === 'true';
  if (type === 'json')    { try { return JSON.parse(value); } catch { return value; } }
  return value;
}

async function getPublicConfig() {
  const settings = await appSettingRepo.findPublic();
  return settings.reduce((acc, s) => ({ ...acc, [s.key]: cast(s) }), {});
}

// Server-side read of one setting, for code that wants an admin-tunable knob
// rather than an env var (env needs a redeploy; this takes effect on the next
// read). `fallback` covers a missing row and an unparseable value alike, so a
// setting an admin blanked out cannot turn into NaN in a date calculation.
async function getSetting(key, fallback) {
  const row = await appSettingRepo.findByKey(key);
  if (!row || row.value === null || row.value === '') return fallback;
  const value = cast(row);
  return Number.isNaN(value) ? fallback : value;
}

module.exports = { getPublicConfig, getSetting };
