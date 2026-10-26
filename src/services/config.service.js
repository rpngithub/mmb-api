const appSettingRepo = require('../repositories/appSetting.repository');
const { isValidSetting } = require('./appSettingRules');

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
// setting an admin blanked out cannot turn into NaN in a date calculation. It
// also covers a value that breaks the key's rule (appSettingRules) — one stored
// before the rule existed, or written straight to the DB — checked on the raw
// text, since parseInt would quietly turn "1.5" into 1.
async function getSetting(key, fallback) {
  const row = await appSettingRepo.findByKey(key);
  if (!row || row.value === null || row.value === '') return fallback;
  if (!isValidSetting(key, row.value)) {
    console.warn(`[config] app setting ${key}=${JSON.stringify(row.value)} is invalid; using ${JSON.stringify(fallback)}`);
    return fallback;
  }
  const value = cast(row);
  return Number.isNaN(value) ? fallback : value;
}

// getSetting for several keys in ONE query — `fallbacks` is { key: fallback }.
// Same per-key rules: a missing, blank, rule-breaking or unparseable value reads
// as its fallback.
async function getSettings(fallbacks) {
  const keys = Object.keys(fallbacks);
  const rows = await appSettingRepo.findMany({ key: keys });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return Object.fromEntries(keys.map((key) => {
    const row = byKey.get(key);
    if (!row || row.value === null || row.value === '') return [key, fallbacks[key]];
    if (!isValidSetting(key, row.value)) {
      console.warn(`[config] app setting ${key}=${JSON.stringify(row.value)} is invalid; using ${JSON.stringify(fallbacks[key])}`);
      return [key, fallbacks[key]];
    }
    const value = cast(row);
    return [key, Number.isNaN(value) ? fallbacks[key] : value];
  }));
}

module.exports = { getPublicConfig, getSetting, getSettings };
