const devSmsService = require('../services/devSms.service');

const testSms = async (req, res) => {
  const result = await devSmsService.testSms(req.body);
  res.json({ success: true, data: result });
};

module.exports = { testSms };
