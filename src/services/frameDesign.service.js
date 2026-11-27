const { v4: uuid } = require('uuid');
const { UniqueConstraintError } = require('sequelize');
const frameRepo     = require('../repositories/frame.repository');
const userFrameRepo = require('../repositories/userFrame.repository');
const designRepo    = require('../repositories/userFrameDesign.repository');
const userRepo      = require('../repositories/user.repository');
const thumbnail     = require('./projectThumbnail.service');
const s3            = require('../utils/s3Helper');
const { FrameVersion } = require('../models');
const { NotFoundError, ForbiddenError } = require('../errors');

/**
 * A user's edited copy of a frame they own — one per VERSION (language × size),
 * because a 4:5 layout is a different design from a 1:1 one.
 *
 * The original on frame_versions is never written by users. GET /frames/:uid
 * serves the copy in its place for the picked version (frame.service); the store
 * always shows the original — it shows what is for sale.
 *
 * Lifecycle, as decided with the product owner (2026-11-27):
 *   - saved with PUT (content every autosave, thumbnail on a slower tick — an
 *     omitted thumbnail keeps the current one);
 *   - reset with DELETE, which brings the original back;
 *   - REMOVING the frame from My Frames deletes every copy of it, unlike the
 *     ownership row, which is kept — re-adding starts from the original;
 *   - an admin moving or merging the version away drops its copies
 *     (frameFamilyAdmin), since the owners who follow it may not be the same;
 *   - an admin change to the version afterwards is NOT applied to copies.
 *     `original_updated` says so: the copy refers to the version's bundle files by
 *     name, and the change may have replaced them, so the app offers a reset.
 *
 * Content is opaque here, as on projects: which components a user may change is
 * the editor's rule, not the API's.
 *
 * The thumbnail follows project thumbnails (projectThumbnail.service): inline,
 * sniffed, 500 KB, content-hash key, outside storage quota, under
 * users/<user uid>/frames/<version uid>/ so the account purge sweeps it.
 */

const folderFor = (userUid, versionUid) => `users/${userUid}/frames/${versionUid}/`;

// Only previews this feature wrote are deleted; anything else is left alone.
const OWN_THUMB = /^users\/[^/]+\/frames\/[^/]+\/thumb-/;

// Best effort, after the rows are gone: an orphaned preview is wasted space, not
// worth failing the request that removed it.
async function deleteThumbnails(keys) {
  for (const key of keys) {
    if (!key || !OWN_THUMB.test(key)) continue;
    try { await s3.deleteFile(key); } catch (err) {
      console.warn(`[FrameDesign] could not delete ${key}: ${err.message}`);
    }
  }
}

const ms = (d) => (d ? new Date(d).getTime() : null);

// Has the admin changed the original since this copy was made? Compared against
// the version's updated_at when the copy was FIRST saved (or last reset), so it
// stays raised until the user resets — autosaving does not quietly clear it.
function originalUpdated(design, version) {
  const base = ms(design.original_updated_at);
  const now  = ms(version?.updated_at);
  return base !== null && now !== null && now > base;
}

// What the API says about a copy. Never the content.
const summary = (design, version) => ({
  uid:              design.uid,
  thumbnail_s3_key: design.thumbnail_s3_key,
  created_at:       design.created_at,
  updated_at:       design.updated_at,
  original_updated: originalUpdated(design, version),
});

// The frame (any status for a reset, live for a save) and one of its versions.
async function frameAndVersion(frameUid, versionUid, { live }) {
  const frame = live ? await frameRepo.findActiveByUid(frameUid) : await frameRepo.findOne({ uid: frameUid });
  if (!frame) throw new NotFoundError('Frame not found');
  const version = await FrameVersion.findOne({
    where: { uid: versionUid, frame_id: frame.id },
    attributes: ['id', 'uid', 'frame_id', 'status', 'updated_at'],
  });
  if (!version || (live && version.status !== 'active')) throw new NotFoundError('Frame version not found');
  return { frame, version };
}

/**
 * Save the caller's copy of one version (create or replace). The frame must be in
 * their My Frames and the version live.
 */
async function saveDesign(frameUid, versionUid, userId, { content, thumbnail: image }) {
  const { frame, version } = await frameAndVersion(frameUid, versionUid, { live: true });

  const owned = await userFrameRepo.findForUserAndFrame(userId, frame.id);
  if (!owned || owned.status !== 'active') throw new ForbiddenError('Add this frame to My Frames before editing it');

  let design = await designRepo.findForUserAndVersion(userId, version.id);

  let thumbKey = design ? design.thumbnail_s3_key : null;
  if (image !== undefined) {
    const user = await userRepo.findById(userId, { attributes: ['uid'] });
    thumbKey = await thumbnail.store(image, { folder: folderFor(user.uid, version.uid), currentKey: thumbKey });
  }

  if (!design) {
    try {
      design = await designRepo.create({
        uid: uuid(), user_id: userId, frame_version_id: version.id,
        content, thumbnail_s3_key: thumbKey, original_updated_at: version.updated_at,
      });
    } catch (err) {
      // Two first autosaves racing: the other one created it — fall through to update.
      if (!(err instanceof UniqueConstraintError)) throw err;
      design = await designRepo.findForUserAndVersion(userId, version.id);
    }
  }
  if (design.content !== content || design.thumbnail_s3_key !== thumbKey) {
    await design.update({ content, thumbnail_s3_key: thumbKey });
  }

  return { frame_uid: frame.uid, version_uid: version.uid, ...summary(design, version) };
}

/** Reset one version to the original: delete the caller's copy. */
async function resetDesign(frameUid, versionUid, userId) {
  const { version } = await frameAndVersion(frameUid, versionUid, { live: false });
  const design = await designRepo.findForUserAndVersion(userId, version.id);
  if (!design) throw new NotFoundError('You have no edited copy of this frame version');
  await design.destroy();
  await deleteThumbnails([design.thumbnail_s3_key]);
}

/** Every copy a user has of one frame — called when they remove it from My Frames. */
async function dropForUserFrame(userId, frameId) {
  const designs = await designRepo.findForUserAndFrame(userId, frameId);
  if (!designs.length) return 0;
  await designRepo.model.destroy({ where: { id: designs.map((d) => d.id) } });
  await deleteThumbnails(designs.map((d) => d.thumbnail_s3_key));
  return designs.length;
}

/**
 * Every user's copy of these versions, inside the caller's transaction. Returns
 * the thumbnail keys to delete with deleteThumbnails() AFTER the commit — a
 * rolled-back move must not have deleted anything.
 */
async function dropForVersions(versionIds, transaction) {
  const designs = await designRepo.findForVersions(versionIds, transaction);
  if (!designs.length) return [];
  await designRepo.model.destroy({ where: { id: designs.map((d) => d.id) }, transaction });
  return designs.map((d) => d.thumbnail_s3_key);
}

const countForVersions = (versionIds) => (versionIds.length
  ? designRepo.model.count({ where: { frame_version_id: versionIds } })
  : Promise.resolve(0));

module.exports = {
  saveDesign, resetDesign, dropForUserFrame, dropForVersions, countForVersions, deleteThumbnails,
  summary, originalUpdated, folderFor,
};
