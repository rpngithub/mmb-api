const { v4: uuid }   = require('uuid');
const projectRepo    = require('../repositories/project.repository');
const businessRepo   = require('../repositories/business.repository');
const templateRepo   = require('../repositories/template.repository');
const variantAccess  = require('./variantAccess.service');
const thumbnail      = require('./projectThumbnail.service');
const userRepo       = require('../repositories/user.repository');
const notify         = require('./notification.service');
const quota          = require('./quota.service');
const dedupe         = require('../utils/dedupeKey');
const { templateMeterFor } = require('../constants/quotaMeters');
const { PROJECT_SOURCE }   = require('../constants/quotaSources');
const { TemplateSize } = require('../models');
const { NotFoundError, ForbiddenError, ValidationError } = require('../errors');

// The plan meter a project made from this template counts against — Business
// Posts for image designs, Video for video/animated — or null for a blank project.
// template_id is fixed at creation (it is not in the update schema), so a blank
// project can never be pointed at a template afterwards to dodge the count.
async function templateMeter(templateId) {
  if (!templateId) return null;
  const tpl = await templateRepo.findById(templateId, {
    attributes: ['id'], include: [{ association: 'family', attributes: ['template_type'] }],
  });
  return templateMeterFor(tpl?.family?.template_type);
}

// Foreign keys arrive from the client; validate existence (and ownership for the
// business) before persisting, so a project can't point at another user's
// business or a non-existent/inactive template/size. Returns the template's plan
// meter (see templateMeter) so the caller can charge it.
async function validateProjectRefs(userId, data) {
  let meter = null;
  if (data.business_id !== undefined) {
    const biz = await businessRepo.findById(data.business_id);
    if (!biz || biz.is_active !== 1) throw new ValidationError('Invalid business_id');
    if (biz.user_id !== userId) throw new ForbiddenError('Business not owned by caller');
  }
  if (data.template_id !== undefined) {
    // template_id is a VERSION (one language × size of a design); both it and its
    // family must be live.
    const tpl = await templateRepo.findById(data.template_id, { include: [{ association: 'family', attributes: ['id', 'status', 'template_type'] }] });
    if (!tpl || tpl.status !== 'active' || tpl.family?.status !== 'active') throw new ValidationError('Invalid template_id');
    // A variant template may only be turned into a project by a user who can access it
    // (entitled or has adopted a variant containing it) — otherwise premium variant
    // content would leak into a free user's projects.
    const access = await variantAccess.canAccessFamily(tpl.family_id, { userId });
    if (access.variantGated && !access.allowed) {
      throw new ForbiddenError('This template requires an active subscription or an adopted variant');
    }
    meter = templateMeterFor(tpl.family.template_type);
  }
  if (data.size_id !== undefined) {
    const size = await TemplateSize.findByPk(data.size_id);
    if (!size || size.is_active !== 1) throw new ValidationError('Invalid size_id');
  }
  return meter;
}

// The editor's autosave sends the preview inline (`thumbnail`, a data URL) with
// the content, so one request saves both. Stored under a project-scoped key and
// swapped for `thumbnail_s3_key` before the row is written; a bad image fails the
// whole request, so content and preview never get out of step. See
// projectThumbnail.service for why this bypasses the presign flow.
async function withThumbnail(userId, projectUid, data, currentKey = null) {
  const { thumbnail: image, ...rest } = data;
  if (image === undefined) return rest;
  const user = await userRepo.findById(userId, { attributes: ['uid'] });
  rest.thumbnail_s3_key = await thumbnail.store(image, { userUid: user.uid, projectUid, currentKey });
  return rest;
}

async function createProject(userId, data) {
  const meter = await validateProjectRefs(userId, data);
  // Checked before anything is written — including the thumbnail upload — so a
  // refused project leaves nothing behind.
  if (meter) await quota.assertWithinQuota(userId, meter);

  const projectUid = uuid();
  const fields     = await withThumbnail(userId, projectUid, data);
  const project    = await projectRepo.create({ ...fields, uid: projectUid, user_id: userId, status: 'draft' });

  if (meter) {
    await quota.consume(userId, meter, 1, { source: PROJECT_SOURCE[meter], ref_type: 'project', ref_id: project.id });
  }

  // "Congratulations! You created your first design." The dedupe key has no scope
  // beyond the code, so this is a genuine once-per-lifetime notification and the
  // count below is only an optimisation — the unique index is what guarantees it.
  const total = await projectRepo.model.count({ where: { user_id: userId } });
  if (total === 1) {
    notify.notify({
      code: 'first_design_created', userId,
      dedupeKey: dedupe.once('first_design_created'),
    });
  }

  return project;
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

  // Archiving frees the project's slot when its meter counts what is kept, so
  // bringing one back has to find room again.
  if (project.status === 'archived' && data.status && data.status !== 'archived') {
    const meter = await templateMeter(project.template_id);
    if (meter) await quota.assertRoomToRestore(userId, meter);
  }

  const fields = await withThumbnail(userId, project.uid, data, project.thumbnail_s3_key);
  await projectRepo.update(project.id, fields);
  return projectRepo.findByUid(uid);
}

async function deleteProject(uid, userId) {
  const project = await projectRepo.findByUid(uid);
  if (!project) throw new NotFoundError('Project not found');
  if (project.user_id !== userId) throw new ForbiddenError('Access denied');
  await projectRepo.update(project.id, { status: 'archived' });
}

module.exports = { createProject, getMyProjects, getProject, updateProject, deleteProject };
