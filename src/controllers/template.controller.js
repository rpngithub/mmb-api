const templateService = require('../services/template.service');

const list = async (req, res) => {
  const items = await templateService.listTemplates(req.query, req.user);
  res.json({ success: true, data: items });
};

const getOne = async (req, res) => {
  const tpl = await templateService.getTemplate(req.params.uid, req.user);
  res.json({ success: true, data: tpl });
};

module.exports = { list, getOne };
