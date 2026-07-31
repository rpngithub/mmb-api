const { v4: uuid }   = require('uuid');
const projectRepo    = require('../repositories/project.repository');
const businessRepo   = require('../repositories/business.repository');
const templateRepo   = require('../repositories/template.repository');
const variantAccess  = require('./variantAccess.service');
const { TemplateSize } = require('../models');
const { NotFoundError, ForbiddenError, ValidationError } = require('../errors');

// Foreign keys arrive from the client; validate existence (and ownership for the
// business) before persisting, so a project can't point at another user's
// business or a non-existent/inactive template/size.
async function validateProjectRefs(userId, data) {
  if (data.business_id !== undefined) {
    const biz = await businessRepo.findById(data.business_id);
    if (!biz || biz.is_active !== 1) throw new ValidationError('Invalid business_id');
    if (biz.user_id !== userId) throw new ForbiddenError('Business not owned by caller');
  }
  if (data.template_id !== undefined) {
    const tpl = await templateRepo.findById(data.template_id);
    if (!tpl || tpl.status !== 'active') throw new ValidationError('Invalid template_id');
    // A variant template may only be turned into a project by a user who can access it
    // (entitled or has adopted a variant containing it) — otherwise premium variant
    // content would leak into a free user's projects.
    const access = await variantAccess.canAccessTemplate(data.template_id, { userId });
    if (access.variantGated && !access.allowed) {
      throw new ForbiddenError('This template requires an active subscription or an adopted variant');
    }
  }
  if (data.size_id !== undefined) {
    const size = await TemplateSize.findByPk(data.size_id);
    if (!size || size.is_active !== 1) throw new ValidationError('Invalid size_id');
  }
}

async function createProject(userId, data) {
  await validateProjectRefs(userId, data);
  return projectRepo.create({ ...data, uid: uuid(), user_id: userId, status: 'draft' });
}

async function getMyProjects(userId) {
  return projectRepo.findMyProjects(userId);
}

async function getProject(uid, userId) {
  const project = await projectRepo.findByUid(uid);
  if (!project) throw new NotFoundError('Project not found');
  if (project.user_id !== userId) throw new ForbiddenError('Access denied');
  return project;
}

async function updateProject(uid, userId, data) {
  const project = await projectRepo.findByUid(uid);
  if (!project) throw new NotFoundError('Project not found');
  if (project.user_id !== userId) throw new ForbiddenError('Access denied');
  await projectRepo.update(project.id, data);
  return projectRepo.findByUid(uid);
}

async function deleteProject(uid, userId) {
  const project = await projectRepo.findByUid(uid);
  if (!project) throw new NotFoundError('Project not found');
  if (project.user_id !== userId) throw new ForbiddenError('Access denied');
  await projectRepo.update(project.id, { status: 'archived' });
}

module.exports = { createProject, getMyProjects, getProject, updateProject, deleteProject };
