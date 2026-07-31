const appSettingRepo = require('../repositories/appSetting.repository');

async function getPublicConfig() {
  const settings = await appSettingRepo.findPublic();
  return settings.reduce((acc, s) => {
    let value = s.value;
    if (s.type === 'integer') value = parseInt(value, 10);
    else if (s.type === 'boolean') value = value === 'true';
    else if (s.type === 'json') { try { value = JSON.parse(value); } catch { /* keep string */ } }
    acc[s.key] = value;
    return acc;
  }, {});
}

module.exports = { getPublicConfig };
