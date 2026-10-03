const templateService = require('../services/template.service');

const list = async (req, res) => {
  const items = await templateService.listTemplates(req.query, req.user);
  res.json({ success: true, data: items });
};

// `?switch=1`: the editor moving between versions of a design it already has open —
// served the same, but not counted as another view.
const getOne = async (req, res) => {
  const countView = !['1', 'true'].includes(String(req.query.switch));
  const tpl = await templateService.getTemplate(req.params.uid, req.user, { countView });
  res.json({ success: true, data: tpl });
};

const getFamily = async (req, res) => {
  const tpl = await templateService.getFamily(req.params.uid, req.user);
  res.json({ success: true, data: tpl });
};

module.exports = { list, getOne, getFamily };
