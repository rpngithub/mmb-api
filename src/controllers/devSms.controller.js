const devSmsService  = require('../services/devSms.service');
const devMailService = require('../services/devMail.service');

const testSms = async (req, res) => {
  const result = await devSmsService.testSms(req.body);
  res.json({ success: true, data: result });
};

const testEmail = async (req, res) => {
  const result = await devMailService.testEmail(req.body);
  res.json({ success: true, data: result });
};

module.exports = { testSms, testEmail };
