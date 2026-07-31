const projectService = require('../services/project.service');
const exportService  = require('../services/projectExport.service');

const create = async (req, res) => {
  const project = await projectService.createProject(req.user.userId, req.body);
  res.status(201).json({ success: true, data: project });
};

const list = async (req, res) => {
  const items = await projectService.getMyProjects(req.user.userId);
  res.json({ success: true, data: items });
};

const getOne = async (req, res) => {
  const project = await projectService.getProject(req.params.uid, req.user.userId);
  res.json({ success: true, data: project });
};

const update = async (req, res) => {
  const project = await projectService.updateProject(req.params.uid, req.user.userId, req.body);
  res.json({ success: true, data: project });
};

const remove = async (req, res) => {
  await projectService.deleteProject(req.params.uid, req.user.userId);
  res.json({ success: true, data: null });
};

const createExport = async (req, res) => {
  const record = await exportService.createExport(req.params.uid, req.user.userId, req.body);
  res.status(201).json({ success: true, data: record });
};

const listExports = async (req, res) => {
  const items = await exportService.listExports(req.params.uid, req.user.userId);
  res.json({ success: true, data: items });
};

module.exports = { create, list, getOne, update, remove, createExport, listExports };
