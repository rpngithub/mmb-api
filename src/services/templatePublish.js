const { Op } = require('sequelize');
const { Template, TemplateFamily, Language } = require('../models');
const { ValidationError, ConflictError, NotFoundError } = require('../errors');
const picker = require('./templateFamilyPicker');

// Server-side mirror of the admin panel's publish checklists. Two levels, because a
// design (template family) and each of its versions go live separately: a draft
// Tamil version must not block the live English one.
//
// FAMILY — may reach `active` once it can be found and opened by everyone it targets:
//   - a taxonomy anchor — category OR at least one industry (public browse is
//     anchored on exactly those two, so a family with neither is unreachable),
//   - at least one tag,
//   - an ACTIVE English version — or, for a text-free family, an active text-free
//     one — in ANY size. The default size (app_settings.default_template_size) is
//     deliberately not required: some designs only exist in one format (a YouTube
//     thumbnail, a WhatsApp-status-only event). It is only a ranking preference
//     when the catalogue picks which version a card shows (templateFamilyPicker).
//
// VERSION — may reach `active` once it can render: bundle uploaded (content), a
// thumbnail and a size. Its language must match the family's kind (a family is all
// text-free or all languages, never a mix) — that rule is enforced on every write.
//
// Create can never publish: content/thumbnail are written by the bundle flow, which
// needs the uid that create returns. So a new version — and a new family, which has
// no versions yet — is always a draft.

const ENGLISH = 'en';

async function englishId() {
  const row = await Language.findOne({ where: { code: ENGLISH }, attributes: ['id'] });
  return row ? row.id : null;
}

// Does the family hold the version its publish rule requires?
async function hasRequiredVersion(familyId, { excludeVersionId } = {}) {
  const enId = await englishId();
  const where = {
    family_id: familyId,
    status:    'active',
    [Op.or]:   [{ language_id: null }, ...(enId ? [{ language_id: enId }] : [])],
  };
  if (excludeVersionId) where.id = { [Op.ne]: excludeVersionId };
  return (await Template.count({ where })) > 0;
}

async function requiredVersionMessage() {
  return 'An active English version (or a text-free one) is required';
}

async function missingForFamily(row, patch = {}) {
  // Evaluate the state the row WOULD have after this write, so a request that sets
  // category_id and status together isn't judged on the pre-update value.
  const next = { ...(row ? row.toJSON() : {}), ...patch };

  const [tags, industries, required] = row
    ? await Promise.all([row.countTags(), row.countBusinessCategories(), hasRequiredVersion(row.id)])
    : [0, 0, false];

  const missing = [];
  const need = (ok, field, message) => { if (!ok) missing.push({ field, message }); };

  need(String(next.name || '').trim(),     'name',        'Name is required');
  need(next.category_id || industries > 0, 'category_id', 'A template category or at least one industry is required');
  need(tags > 0,                           'tag_ids',     'At least one tag is required');
  need(required,                           'versions',    await requiredVersionMessage());

  return missing;
}

function missingForVersion(row, patch = {}) {
  const next = { ...(row ? row.toJSON() : {}), ...patch };
  const missing = [];
  const need = (ok, field, message) => { if (!ok) missing.push({ field, message }); };

  need(String(next.content || '').trim(),          'content',          'Bundle has not been uploaded');
  need(String(next.thumbnail_s3_key || '').trim(), 'thumbnail_s3_key', 'Thumbnail is not set');
  need(next.size_id,                               'size_id',          'A size is required');

  return missing;
}

/**
 * Reject a write that would publish an incomplete family (400 VALIDATION_ERROR with
 * one `details` entry per unmet requirement, keyed by field).
 *
 * Only the TRANSITION into `active` is guarded — moving back to draft/inactive is
 * always allowed, and editing a family that is already active does not re-run the
 * check. (Losing the required version later is handled by reconcileFamily.)
 */
async function assertFamilyPublishable(row, patch = {}) {
  if (patch.status !== 'active') return;
  if (row && row.status === 'active') return;

  const missing = await missingForFamily(row, patch);
  if (missing.length) throw new ValidationError('Template family is not ready to publish', missing);
}

// Would `languageId` break the family's kind? A family is all text-free (NULL) or all
// languages. Returns an error message, or null when it fits.
async function languageKindConflict(familyId, languageId, { excludeVersionId } = {}) {
  const where = { family_id: familyId };
  if (excludeVersionId) where.id = { [Op.ne]: excludeVersionId };
  const others = await Template.findAll({ where, attributes: ['language_id'] });
  if (!others.length) return null;
  const familyIsTextFree = others.every((o) => o.language_id === null);
  const versionIsTextFree = languageId === null || languageId === undefined;
  if (familyIsTextFree && !versionIsTextFree) return 'This family is text-free; its versions cannot have a language';
  if (!familyIsTextFree && versionIsTextFree) return 'This family has languages; a text-free version cannot join it';
  return null;
}

// Is the (family, language, size) slot free?
async function slotTaken(familyId, languageId, sizeId, { excludeVersionId } = {}) {
  if (!sizeId) return false;
  const where = { family_id: familyId, language_id: languageId ?? null, size_id: sizeId };
  if (excludeVersionId) where.id = { [Op.ne]: excludeVersionId };
  return (await Template.count({ where })) > 0;
}

/**
 * beforeWrite for version create/update: the family exists, the language fits the
 * family's kind, the (language, size) slot is free, and a transition to `active`
 * is complete.
 */
async function assertVersionWritable(patch, row) {
  const familyId = row ? row.family_id : patch.family_id;
  if (!row) {
    const family = await TemplateFamily.findByPk(familyId, { attributes: ['id'] });
    if (!family) throw new NotFoundError('Template family not found');
  }

  const languageId = patch.language_id !== undefined ? patch.language_id : (row ? row.language_id : null);
  const sizeId     = patch.size_id     !== undefined ? patch.size_id     : (row ? row.size_id : null);
  const exclude    = { excludeVersionId: row ? row.id : undefined };

  const kind = await languageKindConflict(familyId, languageId, exclude);
  if (kind) throw new ValidationError(kind, [{ field: 'language_id', message: kind }]);
  if (await slotTaken(familyId, languageId, sizeId, exclude)) {
    throw new ConflictError('This family already has a version in that language and size');
  }

  if (patch.status === 'active' && !(row && row.status === 'active')) {
    const missing = missingForVersion(row, patch);
    if (missing.length) throw new ValidationError('Template version is not ready to publish', missing);
  }
}

// adminCrud beforeWrite for versions: the checks above, plus a default label — a
// version's name is optional and falls back to its family's.
async function versionBeforeWrite(payload, row) {
  await assertVersionWritable(payload, row);
  if (!row && !payload.name) {
    const family = await TemplateFamily.findByPk(payload.family_id, { attributes: ['name'] });
    payload.name = family.name;
  }
}

/**
 * Keep a LIVE family consistent after its versions change (a version unpublished,
 * deleted, relabelled or moved away): if it no longer holds the version its publish
 * rule requires, it goes back to draft rather than serving a design that cannot be
 * shown to everyone it targets. Returns true when it reverted.
 */
async function reconcileFamily(familyId, { transaction } = {}) {
  const family = await TemplateFamily.findByPk(familyId, { transaction });
  if (!family || family.status !== 'active') return false;
  if (await hasRequiredVersion(familyId)) return false;
  await family.update({ status: 'draft' }, { transaction });
  return true;
}

module.exports = {
  missingForFamily, missingForVersion, assertFamilyPublishable, assertVersionWritable, versionBeforeWrite,
  languageKindConflict, slotTaken, hasRequiredVersion, reconcileFamily, requiredVersionMessage,
};
