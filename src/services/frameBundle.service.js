const { Op } = require('sequelize');
const { FrameVersion } = require('../models');
const s3 = require('../utils/s3Helper');
const upload = require('./upload.service');
const publish = require('./framePublish');
const { NotFoundError, ValidationError, ConflictError } = require('../errors');

// Frame version bundles — the same contract as template bundles. The admin panel
// unzips the designer ZIP in the browser and PUTs every file straight to
// frames/<version uid>/<filename> (presign target { type:'frame_file',
// frame_version_uid }), tagged pending. Confirm then flips them all to active and
// saves the design JSON and thumbnail. The JSON references its files by bare
// filename, resolved against that folder (`asset_prefix` on every public version).
//
// A version's uid never changes — move and merge keep it — so its folder stays valid
// wherever the version goes.

async function versionByUid(uid) {
  const version = await FrameVersion.findOne({ where: { uid } });
  if (!version) throw new NotFoundError('Frame version not found');
  return version;
}

// Other versions whose design or thumbnail points into this folder. None are made
// that way today; kept because a folder shared by two versions must never be wiped
// from under one of them (template bundles hit exactly this after migration 045).
function sharingCount(version, prefix) {
  return FrameVersion.count({
    where: {
      id: { [Op.ne]: version.id },
      [Op.or]: [{ thumbnail_s3_key: { [Op.like]: `${prefix}%` } }, { content: { [Op.like]: `%${prefix}%` } }],
    },
  });
}

/**
 * Finalize a bundle: activate every object under the folder and save `content`
 * and/or the thumbnail (at least one; the schema enforces it). Sending only
 * `thumbnail_filename` swaps the thumbnail and leaves the saved design alone.
 * Everything is checked before any object is activated.
 */
async function confirmBundle(uid, { content, thumbnail_filename: thumbnailFilename }) {
  const version = await versionByUid(uid);
  const prefix  = upload.frameBundlePrefix(version.uid);
  const keys    = await s3.listKeys(prefix);

  const patch = {};
  if (content !== undefined) patch.content = content;
  if (thumbnailFilename) {
    const key = upload.buildKey({ type: 'frame_file', frame_version_uid: version.uid }, thumbnailFilename);
    if (!keys.includes(key)) {
      throw new ValidationError('Validation failed', [
        { field: 'thumbnail_filename', message: `No uploaded file named "${thumbnailFilename}" under ${prefix}` },
      ]);
    }
    patch.thumbnail_s3_key = key;
  }

  for (const key of keys) await s3.putObjectTagging(key, 'active');
  await version.update(patch);
  return { version, objects: keys.length };
}

/**
 * Wipe the folder for a clean re-upload, and clear what pointed into it: the design
 * (`content`) and a thumbnail stored there. A thumbnail kept elsewhere — the old
 * `frames/thumbnail/` slot that migration 058 versions use — is left as it is. A
 * live version cannot stay live without a design, so it goes back to draft, and a
 * live frame that thereby loses its required version follows (reconcileFrame).
 */
async function resetBundle(uid) {
  const version = await versionByUid(uid);
  const prefix  = upload.frameBundlePrefix(version.uid);

  const sharing = await sharingCount(version, prefix);
  if (sharing) {
    throw new ConflictError(`${sharing} other version(s) still use this version's files. Upload their own bundles first, then reset this one.`);
  }

  await s3.deleteByPrefix(prefix);

  const patch = { content: null };
  if (String(version.thumbnail_s3_key || '').startsWith(prefix)) patch.thumbnail_s3_key = null;
  if (version.status === 'active') patch.status = 'draft';
  await version.update(patch);
  const frameDrafted = await publish.reconcileFrame(version.frame_id);
  return { version, frame_drafted: frameDrafted };
}

// After a version is deleted: remove its folder. Best effort — the row is already
// gone, and a storage hiccup must not turn a successful delete into an error; the
// orphaned files are then only wasted space.
async function removeFiles(version) {
  const prefix = upload.frameBundlePrefix(version.uid);
  try {
    if (await sharingCount(version, prefix)) return;
    await s3.deleteByPrefix(prefix);
  } catch (err) {
    console.warn(`[frames] could not delete ${prefix} after its version was deleted: ${err.message}`);
  }
}

module.exports = { confirmBundle, resetBundle, removeFiles };
