const configService = require('../services/config.service');

const getConfig = async (req, res) => {
  const config = await configService.getPublicConfig();
  res.json({ success: true, data: config });
};

module.exports = { getConfig };
