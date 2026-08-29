const { v4: uuid } = require('uuid');
const exportRepo   = require('../repositories/projectExport.repository');
const projectRepo  = require('../repositories/project.repository');
const quota        = require('./quota.service');
const { NotFoundError, ForbiddenError } = require('../errors');

async function _assertProjectOwner(projectUid, userId) {
  const project = await projectRepo.findByUid(projectUid);
  if (!project) throw new NotFoundError('Project not found');
  if (project.user_id !== userId) throw new ForbiddenError('Access denied');
  return project;
}

async function createExport(projectUid, userId, { export_type, platform, s3_key }) {
  const project = await _assertProjectOwner(projectUid, userId);

  // download vs share consume different quota buckets.
  const feature = export_type === 'share' ? 'shares' : 'downloads';
  await quota.assertWithinQuota(userId, feature);

  const record = await exportRepo.create({
    uid:         uuid(),
    project_id:  project.id,
    user_id:     userId,
    export_type,
    platform:    platform || null,
    s3_key:      s3_key || null,
    status:      'success',
  });

  await quota.consume(userId, feature, 1, {
    source:   export_type === 'share' ? 'share' : 'download',
    ref_type: 'project_export',
    ref_id:   record.id,
  });
  return record;
}

async function listExports(projectUid, userId) {
  const project = await _assertProjectOwner(projectUid, userId);
  return exportRepo.findByProject(project.id);
}

module.exports = { createExport, listExports };
