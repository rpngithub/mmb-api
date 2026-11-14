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
const featureTypeRepo = require('../repositories/featureType.repository');
const eventRepo      = require('../repositories/quotaUsageEvent.repository');
const { projectMeterFor, projectTypeForTemplate, modeOf } = require('../constants/quotaMeters');
const { PROJECT_SOURCE }   = require('../constants/quotaSources');
const { PROJECT_TYPES }    = require('../validators/project.validator');
const { TemplateSize } = require('../models');
const { NotFoundError, ForbiddenError, ValidationError } = require('../errors');

// Plan meters: a project made from a template counts against Business Posts when
// it is an image and Video when it is a video — by the PROJECT's type, which the
// editor changes when it adds or removes animation (projectMeterFor). A blank
// project is never metered. template_id is fixed at creation (it is not in the
// update schema), so a blank project can never be pointed at a template
// afterwards to start or dodge the count.

// Foreign keys arrive from the client; validate existence (and ownership for the
// business) before persisting, so a project can't point at another user's
// business or a non-existent/inactive template/size. Returns the template's
// family type (null for a blank project), which a new project's type defaults to.
async function validateProjectRefs(userId, data) {
  let templateType = null;
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
    templateType = tpl.family.template_type;
  }
  if (data.size_id !== undefined) {
    const size = await TemplateSize.findByPk(data.size_id);
    if (!size || size.is_active !== 1) throw new ValidationError('Invalid size_id');
  }
  return templateType;
}

// A template project changing type moves to the other bucket. Checks there is
// room and says whether to charge it (the caller consumes AFTER the row is saved,
// as on create):
//
//   gauge (reset 'never', "N kept at a time") — the project leaves the old bucket
//     on its own, since both are counted from rows, and needs a slot in the new
//     one. A project that stays archived occupies nothing; restoring it later
//     asks for the slot then.
//   flow (monthly/annual tally) — the move is a new add to that bucket, but only
//     the FIRST time: toggling animation on and off must not spend a credit on
//     every save. "Has this project ever been charged to this bucket" is read off
//     the usage ledger.
//
// Returns true when the switch should be charged (for a gauge that is only the
// ledger row the breakdown reads).
async function assertTypeSwitch(userId, project, meter, willBeLive) {
  const ft = await featureTypeRepo.findByKey(meter);
  if (!ft) return false;   // no such feature type — nothing to count against

  const gauge = modeOf(ft) === 'gauge';
  if (gauge && !willBeLive) return false;
  if (gauge) await quota.assertWithinQuota(userId, meter, 1);

  if (await eventRepo.hasSpend(userId, ft.id, 'project', project.id)) return false;
  if (!gauge) await quota.assertWithinQuota(userId, meter, 1);
  return true;
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
  const templateType = await validateProjectRefs(userId, data);
  // The editor's word wins (it knows whether the design is animated); otherwise
  // the template's type, and a blank project is an image.
  const projectType = data.project_type || projectTypeForTemplate(templateType);
  const meter = projectMeterFor({ template_id: data.template_id, project_type: projectType });
  // Checked before anything is written — including the thumbnail upload — so a
  // refused project leaves nothing behind.
  if (meter) await quota.assertWithinQuota(userId, meter);

  const projectUid = uuid();
  const fields     = await withThumbnail(userId, projectUid, data);
  const project    = await projectRepo.create({
    ...fields, project_type: projectType, uid: projectUid, user_id: userId, status: 'draft',
  });

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

// `type` is the optional ?type=image|video filter ("My Posts" / "My Videos").
async function getMyProjects(userId, { type } = {}) {
  if (type !== undefined && !PROJECT_TYPES.includes(type)) {
    throw new ValidationError('Validation failed', [{ field: 'type', message: `type must be one of: ${PROJECT_TYPES.join(', ')}` }]);
  }
  return projectRepo.findMyProjects(userId, { type });
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

  // What the project will be once this PATCH lands — a type change and a restore
  // can arrive together, and the bucket that matters is the one it ends up in.
  const next = {
    template_id:  project.template_id,
    project_type: data.project_type || project.project_type,
    status:       data.status || project.status,
  };
  const oldMeter   = projectMeterFor(project);
  const newMeter   = projectMeterFor(next);
  const willBeLive = next.status !== 'archived';

  let chargeSwitch = false;
  if (newMeter && newMeter !== oldMeter) {
    chargeSwitch = await assertTypeSwitch(userId, project, newMeter, willBeLive);
  } else if (newMeter && project.status === 'archived' && willBeLive) {
    // Archiving frees the project's slot when its meter counts what is kept, so
    // bringing one back has to find room again.
    await quota.assertRoomToRestore(userId, newMeter);
  }

  const fields = await withThumbnail(userId, project.uid, data, project.thumbnail_s3_key);
  await projectRepo.update(project.id, fields);

  if (chargeSwitch) {
    await quota.consume(userId, newMeter, 1, { source: PROJECT_SOURCE[newMeter], ref_type: 'project', ref_id: project.id });
  }
  return projectRepo.findByUid(uid);
}

async function deleteProject(uid, userId) {
  const project = await projectRepo.findByUid(uid);
  if (!project) throw new NotFoundError('Project not found');
  if (project.user_id !== userId) throw new ForbiddenError('Access denied');
  await projectRepo.update(project.id, { status: 'archived' });
}

module.exports = { createProject, getMyProjects, getProject, updateProject, deleteProject };
