const { Op, literal } = require('sequelize');
const { Frame, FrameVersion, Language } = require('../models');
const { ValidationError, ConflictError, NotFoundError } = require('../errors');

// Publish checklists for frames, the frames counterpart of templatePublish.js. Two
// levels, because a frame (the family) and each of its versions go live separately:
// a draft Tamil version must not block the live English one.
//
// FRAME — may reach `active` once it can be found and sold coherently:
//   - a category — the store is browsed ONLY by chip, so an uncategorised frame
//     is unreachable (templates get a second anchor via industry; frames have none),
//   - a coherent price: premium means it costs something, free means it does not,
//   - an ACTIVE English version — or, for a text-free frame, an active text-free
//     one — in ANY size, the same rule template families follow. The default size
//     is only a ranking preference for which version a store card shows.
//
// VERSION — may reach `active` once it can render: content, a thumbnail and a size.
// Its language must match the frame's kind (all text-free or all languages, never a
// mix) and its (language, size) slot must be free — enforced on every write.
//
// A version's design arrives as a BUNDLE, like a template version's: files under
// frames/<version uid>/, then content + thumbnail saved by the bundle confirm
// (frameBundle.service). Content/thumbnail may still be PATCHed directly, which is
// how migration 058 versions (self-contained JSON, slot thumbnail) got theirs.

const ENGLISH = 'en';
const REQUIRED_VERSION_MESSAGE = 'An active English version (or a text-free one) is required';

async function englishId() {
  const row = await Language.findOne({ where: { code: ENGLISH }, attributes: ['id'] });
  return row ? row.id : null;
}

// SQL: "this frame holds the version its publish rule requires", for the admin list
// (one correlated subquery per row instead of a query each). `frameRef` is the
// quoted id column in the outer query.
const requiredVersionSql = (frameRef) =>
  `EXISTS (SELECT 1 FROM \`frame_versions\` v LEFT JOIN \`languages\` l ON l.id = v.language_id
     WHERE v.frame_id = ${frameRef} AND v.status = 'active' AND (v.language_id IS NULL OR l.code = '${ENGLISH}'))`;

const requiredVersionAttr = (frameRef) => [literal(requiredVersionSql(frameRef)), 'has_required_version'];

async function hasRequiredVersion(frameId, { excludeVersionId, transaction } = {}) {
  const enId = await englishId();
  const where = {
    frame_id: frameId,
    status:   'active',
    [Op.or]:  [{ language_id: null }, ...(enId ? [{ language_id: enId }] : [])],
  };
  if (excludeVersionId) where.id = { [Op.ne]: excludeVersionId };
  return (await FrameVersion.count({ where, transaction })) > 0;
}

// The frame checklist evaluated over SIGNALS rather than a row, so the admin list
// can report readiness per row from one query (has_required_version is a subquery).
// Both the list and the gate funnel through here so they can never drift.
function missingFromSignals({ name, category_id, is_premium, price, has_required_version }) {
  const missing = [];
  const need = (ok, field, message) => { if (!ok) missing.push({ field, message }); };

  const premium = Number(is_premium) === 1;
  const amount  = Number(price ?? 0);

  need(String(name || '').trim(),     'name',        'Name is required');
  need(category_id,                   'category_id', 'A frame category is required');
  // Both directions matter. A premium frame priced at 0 would be bought for
  // nothing; a free frame with a price set would display a price the store never
  // charges, because the free path skips checkout entirely.
  need(!premium || amount > 0,        'price',       'A premium frame needs a price above zero');
  need(premium  || amount === 0,      'price',       'A free frame cannot have a price');
  need(Number(has_required_version) === 1 || has_required_version === true, 'versions', REQUIRED_VERSION_MESSAGE);

  return missing;
}

async function missingForPublish(row, patch = {}) {
  // Judge the state the row WOULD have after this write, so a request that sets
  // category_id and status together is not tested against the pre-update value.
  const next = { ...(row ? row.toJSON() : {}), ...patch };
  return missingFromSignals({
    ...next,
    // A frame being created has no versions yet, so create can never publish.
    has_required_version: row ? await hasRequiredVersion(row.id) : false,
  });
}

/**
 * Reject a write that would publish an incomplete frame (400 VALIDATION_ERROR
 * with one `details` entry per unmet requirement, keyed by field).
 *
 * Only the TRANSITION into `active` is guarded. UNPUBLISHING — back to draft or
 * inactive — is always allowed; losing the required version later is handled by
 * reconcileFrame.
 *
 * @param {Model|null} row    the frame being updated, or null on create
 * @param {object}     patch  the incoming payload
 */
async function assertPublishable(row, patch = {}) {
  if (patch.status !== 'active') return;
  if (row && row.status === 'active') return;

  const missing = await missingForPublish(row, patch);
  if (missing.length) throw new ValidationError('Frame is not ready to publish', missing);
}

function missingForVersion(row, patch = {}) {
  const next = { ...(row ? row.toJSON() : {}), ...patch };
  const missing = [];
  const need = (ok, field, message) => { if (!ok) missing.push({ field, message }); };

  need(String(next.content || '').trim(),          'content',          'Design content has not been added');
  need(String(next.thumbnail_s3_key || '').trim(), 'thumbnail_s3_key', 'Thumbnail is not set');
  need(next.size_id,                               'size_id',          'A size is required');

  return missing;
}

// Would `languageId` break the frame's kind? Returns an error message, or null.
async function languageKindConflict(frameId, languageId, { excludeVersionId } = {}) {
  const where = { frame_id: frameId };
  if (excludeVersionId) where.id = { [Op.ne]: excludeVersionId };
  const others = await FrameVersion.findAll({ where, attributes: ['language_id'] });
  if (!others.length) return null;
  const frameIsTextFree   = others.every((o) => o.language_id === null);
  const versionIsTextFree = languageId === null || languageId === undefined;
  if (frameIsTextFree && !versionIsTextFree) return 'This frame is text-free; its versions cannot have a language';
  if (!frameIsTextFree && versionIsTextFree) return 'This frame has languages; a text-free version cannot join it';
  return null;
}

// Is the (frame, language, size) slot free?
async function slotTaken(frameId, languageId, sizeId, { excludeVersionId } = {}) {
  if (!sizeId) return false;
  const where = { frame_id: frameId, language_id: languageId ?? null, size_id: sizeId };
  if (excludeVersionId) where.id = { [Op.ne]: excludeVersionId };
  return (await FrameVersion.count({ where })) > 0;
}

/**
 * adminCrud beforeWrite for version create/update: the frame exists, the language
 * fits the frame's kind, the (language, size) slot is free, and a transition to
 * `active` is complete. A version never changes frame here — that is a move.
 */
async function assertVersionWritable(patch, row) {
  const frameId = row ? row.frame_id : patch.frame_id;
  if (!row) {
    const frame = await Frame.findByPk(frameId, { attributes: ['id'] });
    if (!frame) throw new NotFoundError('Frame not found');
  }

  const languageId = patch.language_id !== undefined ? patch.language_id : (row ? row.language_id : null);
  const sizeId     = patch.size_id     !== undefined ? patch.size_id     : (row ? row.size_id : null);
  const exclude    = { excludeVersionId: row ? row.id : undefined };

  const kind = await languageKindConflict(frameId, languageId, exclude);
  if (kind) throw new ValidationError(kind, [{ field: 'language_id', message: kind }]);
  if (await slotTaken(frameId, languageId, sizeId, exclude)) {
    throw new ConflictError('This frame already has a version in that language and size');
  }

  if (patch.status === 'active' && !(row && row.status === 'active')) {
    const missing = missingForVersion(row, patch);
    if (missing.length) throw new ValidationError('Frame version is not ready to publish', missing);
  }
}

/**
 * Keep a LIVE frame consistent after its versions change (a version unpublished,
 * deleted, relabelled or moved away): if it no longer holds the version its publish
 * rule requires it goes back to draft. Owners keep it; the store stops showing it.
 * Returns true when it reverted.
 */
async function reconcileFrame(frameId, { transaction } = {}) {
  const frame = await Frame.findByPk(frameId, { transaction });
  if (!frame || frame.status !== 'active') return false;
  if (await hasRequiredVersion(frameId, { transaction })) return false;
  await frame.update({ status: 'draft' }, { transaction });
  return true;
}

module.exports = {
  missingFromSignals, missingForPublish, assertPublishable, requiredVersionAttr,
  missingForVersion, assertVersionWritable, languageKindConflict, slotTaken,
  hasRequiredVersion, reconcileFrame,
};
