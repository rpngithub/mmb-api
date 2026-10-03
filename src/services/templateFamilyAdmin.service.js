const { Op } = require('sequelize');
const { sequelize, Template, TemplateFamily, Tag, BusinessCategory, Variant, SpecialEvent, TemplateCategory, Language, TemplateSize } = require('../models');
const publish = require('./templatePublish');
const favourites = require('./favourite.service');
const { NotFoundError, ValidationError, ConflictError } = require('../errors');

// Regrouping versions between designs (template families). The migration made every
// existing template a family of one; this is how admins put the pieces of one
// design back together — one version at a time (move) or a whole family (merge).
//
// Rules, shared by both:
//   - a version cannot land in a (language, size) slot the target already fills;
//   - a text-free version cannot join a family with languages, nor vice versa;
//   - the TARGET's shared details win: the moved version takes on its category,
//     industries, tags, access level, variants and events. The dry run lists what
//     that changes (e.g. "becomes Premium") so the admin can confirm first;
//   - a LIVE source that loses the version its publish rule needs goes back to draft;
//   - a source left with no versions is archived (inactive, never deleted), and its
//     views/downloads/trending are added to the target, so the design keeps its
//     popularity; its favourites move to the target and likes are recounted.
// Version uids never change, so projects, deep links and notifications keep working.

const COUNTERS = ['views_count', 'downloads_count', 'likes_count', 'trending_score'];

const RELATIONS = [
  ['Tags',               'tags'],
  ['BusinessCategories', 'industries'],
  ['Variants',           'premium themes (variants)'],
  ['SpecialEvents',      'special events'],
];

const loadFamily = (where) => TemplateFamily.findOne({
  where,
  include: [
    { model: TemplateCategory, attributes: ['id', 'name'] },
    { model: Tag,              attributes: ['id', 'name'], through: { attributes: [] } },
    { model: BusinessCategory, attributes: ['id', 'name'], through: { attributes: [] } },
    { model: Variant,          attributes: ['id', 'name'], through: { attributes: [] } },
    { model: SpecialEvent,     attributes: ['id', 'name'], through: { attributes: [] } },
  ],
});

async function familyByUid(uid, label) {
  const family = await loadFamily({ uid });
  if (!family) throw new NotFoundError(`${label} template family not found`);
  return family;
}

const describe = (v) => `${v.Language ? v.Language.code : 'text-free'} · ${v.TemplateSize ? v.TemplateSize.name : 'no size'}`;

// What changes for a version that leaves `source` for `target` (the target's details win).
function detailChanges(source, target) {
  const changes = [];
  if (Boolean(source.is_premium) !== Boolean(target.is_premium)) {
    changes.push(target.is_premium ? 'Becomes Premium' : 'Becomes Free');
  }
  if ((source.category_id || null) !== (target.category_id || null)) {
    changes.push(`Category changes from "${source.TemplateCategory?.name || 'none'}" to "${target.TemplateCategory?.name || 'none'}"`);
  }
  if (source.template_type !== target.template_type) {
    changes.push(`Type changes from ${source.template_type} to ${target.template_type}`);
  }
  for (const [key, label] of RELATIONS) {
    const from = new Set((source[key] || []).map((r) => r.id));
    const to   = new Set((target[key] || []).map((r) => r.id));
    const dropped = (source[key] || []).filter((r) => !to.has(r.id)).map((r) => r.name);
    const added   = (target[key] || []).filter((r) => !from.has(r.id)).map((r) => r.name);
    if (dropped.length) changes.push(`Leaves ${label}: ${dropped.join(', ')}`);
    if (added.length)   changes.push(`Joins ${label}: ${added.join(', ')}`);
  }
  return changes;
}

// Why each of `versions` cannot join `target` (empty = all fit).
async function conflictsFor(versions, target) {
  const conflicts = [];
  for (const v of versions) {
    const kind = await publish.languageKindConflict(target.id, v.language_id);
    if (kind) conflicts.push({ version_uid: v.uid, version: describe(v), message: kind });
    else if (await publish.slotTaken(target.id, v.language_id, v.size_id)) {
      conflicts.push({ version_uid: v.uid, version: describe(v), message: 'The target already has a version in this language and size' });
    }
  }
  return conflicts;
}

// What happens to the source family once `version` leaves it. (A merge moves every
// version, so its source is always archived.)
async function sourceOutcome(source, version) {
  const total = await Template.count({ where: { family_id: source.id } });
  if (total <= 1) return 'archived';
  if (source.status !== 'active') return 'unchanged';
  return (await publish.hasRequiredVersion(source.id, { excludeVersionId: version.id })) ? 'unchanged' : 'draft';
}

async function applyOutcome(source, target, outcome, transaction) {
  if (outcome === 'archived') {
    const add = {};
    for (const c of COUNTERS) add[c] = (Number(target[c]) || 0) + (Number(source[c]) || 0);
    await target.update(add, { transaction });
    const zero = Object.fromEntries(COUNTERS.map((c) => [c, 0]));
    await source.update({ ...zero, status: 'inactive' }, { transaction });
    // Hearts follow the design, and likes_count is then RECOUNTED rather than summed
    // above — a user who hearted both designs keeps one heart and counts once.
    await favourites.moveTemplateFavourites(source.id, target.id, transaction);
  } else if (outcome === 'draft') {
    await source.update({ status: 'draft' }, { transaction });
  }
}

const versionInclude = [
  { model: Language,     attributes: ['id', 'code', 'name'] },
  { model: TemplateSize, attributes: ['id', 'slug', 'name'] },
];

/**
 * Move one version into another family.
 * @returns {object} the plan: target, changes, source outcome, conflicts; `applied`
 *   says whether it was carried out (false on a dry run).
 */
async function moveVersion(versionUid, targetFamilyUid, { dryRun = false } = {}) {
  const version = await Template.findOne({ where: { uid: versionUid }, include: versionInclude });
  if (!version) throw new NotFoundError('Template version not found');
  const target = await familyByUid(targetFamilyUid, 'Target');
  if (target.id === version.family_id) throw new ValidationError('The version is already in that family');
  const source = await loadFamily({ id: version.family_id });

  const conflicts = await conflictsFor([version], target);
  const outcome   = await sourceOutcome(source, version);
  const plan = {
    version:        { uid: version.uid, name: version.name, version: describe(version) },
    source:         { uid: source.uid, name: source.name, outcome },
    target:         { uid: target.uid, name: target.name },
    changes:        detailChanges(source, target),
    conflicts,
    applied:        false,
  };
  if (dryRun) return plan;
  if (conflicts.length) throw new ConflictError('The version cannot join that family', conflicts);

  await sequelize.transaction(async (transaction) => {
    await version.update({ family_id: target.id }, { transaction });
    await applyOutcome(source, target, outcome, transaction);
  });
  plan.applied = true;
  return plan;
}

/**
 * Merge a whole family into another: every version moves, all-or-nothing — one
 * conflict and nothing moves. The emptied source is archived with its counters
 * added to the target.
 */
async function mergeFamily(sourceUid, targetUid, { dryRun = false } = {}) {
  const source = await familyByUid(sourceUid, 'Source');
  const target = await familyByUid(targetUid, 'Target');
  if (source.id === target.id) throw new ValidationError('A family cannot be merged into itself');

  const versions  = await Template.findAll({ where: { family_id: source.id }, include: versionInclude });
  const conflicts = await conflictsFor(versions, target);
  const plan = {
    source:   { uid: source.uid, name: source.name, outcome: 'archived', versions: versions.length },
    target:   { uid: target.uid, name: target.name },
    changes:  detailChanges(source, target),
    conflicts,
    applied:  false,
  };
  if (dryRun) return plan;
  if (conflicts.length) throw new ConflictError('The families cannot be merged', conflicts);

  await sequelize.transaction(async (transaction) => {
    await Template.update({ family_id: target.id }, { where: { family_id: source.id }, transaction });
    await applyOutcome(source, target, 'archived', transaction);
  });
  plan.applied = true;
  return plan;
}

module.exports = { moveVersion, mergeFamily };
