const { Op } = require('sequelize');
const { sequelize, Frame, FrameVersion, FrameCategory, UserFrame, Business, Language, TemplateSize } = require('../models');
const publish = require('./framePublish');
const { NotFoundError, ValidationError, ConflictError } = require('../errors');

// Regrouping versions between frames, the frames counterpart of
// templateFamilyAdmin.service.js. Migration 058 made every frame a family of one;
// this is how admins put size/language copies that were uploaded as separate
// frames back together — one version at a time (move) or a whole frame (merge).
//
// Rules, shared by both:
//   - a version cannot land in a (language, size) slot the target already fills;
//   - a text-free version cannot join a frame with languages, nor vice versa;
//   - the TARGET's details win (category, type, premium, price); the dry run lists
//     what that changes so the admin can confirm first;
//   - a LIVE source that loses the version its publish rule needs goes back to draft;
//   - a source left with no versions is archived (inactive, never deleted — its
//     ownership rows pin it) and its OWNERS follow the design to the target:
//       · a user who owns only the source has their row repointed (status,
//         payment and how they got it all kept);
//       · a user who owns both keeps one target row, upgraded to the better of the
//         two (active over pending over removed; a purchase stays a purchase); the
//         source row is set 'removed' and kept as the record of that payment;
//       · a FREE owner of the source does NOT carry into a PREMIUM target — that
//         would hand out a paid frame. Their row is set 'removed'.
//     Businesses wearing the source as their active frame follow the same way:
//     repointed to the target, or cleared for a dropped owner.
// Version uids never change, so nothing that remembered one breaks.

const STATUS_RANK = { active: 2, pending: 1, removed: 0 };

const loadFrame = (where) => Frame.findOne({ where, include: [{ model: FrameCategory, attributes: ['id', 'name'] }] });

async function frameByUid(uid, label) {
  const frame = await loadFrame({ uid });
  if (!frame) throw new NotFoundError(`${label} frame not found`);
  return frame;
}

const describe = (v) => `${v.Language ? v.Language.code : 'text-free'} · ${v.TemplateSize ? v.TemplateSize.name : 'no size'}`;

const versionInclude = [
  { model: Language,     attributes: ['id', 'code', 'name'] },
  { model: TemplateSize, attributes: ['id', 'slug', 'name'] },
];

// What changes for a version that leaves `source` for `target` (the target's details win).
function detailChanges(source, target) {
  const changes = [];
  if (Boolean(source.is_premium) !== Boolean(target.is_premium)) {
    changes.push(target.is_premium ? `Becomes Premium (₹${target.price})` : 'Becomes Free');
  } else if (source.is_premium && Number(source.price) !== Number(target.price)) {
    changes.push(`Price changes from ₹${source.price} to ₹${target.price}`);
  }
  if ((source.category_id || null) !== (target.category_id || null)) {
    changes.push(`Category changes from "${source.FrameCategory?.name || 'none'}" to "${target.FrameCategory?.name || 'none'}"`);
  }
  if (source.frame_type !== target.frame_type) {
    changes.push(`Type changes from ${source.frame_type} to ${target.frame_type}`);
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

async function sourceOutcome(source, version) {
  const total = await FrameVersion.count({ where: { frame_id: source.id } });
  if (total <= 1) return 'archived';
  if (source.status !== 'active') return 'unchanged';
  return (await publish.hasRequiredVersion(source.id, { excludeVersionId: version.id })) ? 'unchanged' : 'draft';
}

// How each of the source's ownership rows lands on the target (see the rules above).
async function planOwners(source, target, transaction) {
  const rows = await UserFrame.findAll({ where: { frame_id: source.id }, transaction });
  const theirs = rows.length ? await UserFrame.findAll({
    where: { frame_id: target.id, user_id: { [Op.in]: rows.map((r) => r.user_id) } }, transaction,
  }) : [];
  const targetRowOf = new Map(theirs.map((r) => [r.user_id, r]));
  const premiumTarget = Number(target.is_premium) === 1;

  const plan = { carried: [], combined: [], dropped: [] };
  for (const row of rows) {
    if (premiumTarget && row.acquired_via === 'free') plan.dropped.push({ row });
    else if (targetRowOf.has(row.user_id)) plan.combined.push({ row, into: targetRowOf.get(row.user_id) });
    else plan.carried.push({ row });
  }
  return plan;
}

const ownerSummary = (plan) => ({
  carried:  plan.carried.length,
  combined: plan.combined.length,
  dropped:  plan.dropped.length,
});

async function applyOwners(source, target, plan, transaction) {
  for (const { row } of plan.carried) {
    await row.update({ frame_id: target.id }, { transaction });
  }
  for (const { row, into } of plan.combined) {
    const purchase = row.acquired_via === 'purchase' || into.acquired_via === 'purchase';
    await into.update({
      status:       STATUS_RANK[row.status] > STATUS_RANK[into.status] ? row.status : into.status,
      acquired_via: purchase ? 'purchase' : 'free',
      // Keep the target's own payment when it has one: a pending checkout for the
      // target must still find this row when it is fulfilled.
      payment_id:   into.payment_id ?? row.payment_id,
      acquired_at:  into.acquired_at ?? row.acquired_at,
    }, { transaction });
    await row.update({ status: 'removed' }, { transaction });
  }
  for (const { row } of plan.dropped) {
    await row.update({ status: 'removed' }, { transaction });
  }

  const dropped = plan.dropped.map(({ row }) => row.user_id);
  if (dropped.length) {
    await Business.update({ active_frame_id: null },
      { where: { active_frame_id: source.id, user_id: { [Op.in]: dropped } }, transaction });
  }
  await Business.update({ active_frame_id: target.id }, { where: { active_frame_id: source.id }, transaction });
}

async function applyOutcome(source, target, outcome, ownerPlan, transaction) {
  if (outcome === 'archived') {
    await applyOwners(source, target, ownerPlan, transaction);
    await source.update({ status: 'inactive' }, { transaction });
  } else if (outcome === 'draft') {
    await source.update({ status: 'draft' }, { transaction });
  }
}

const activeOwners = (frameId) => UserFrame.count({ where: { frame_id: frameId, status: 'active' } });

/**
 * Move one version into another frame.
 * @returns {object} the plan: target, changes, source outcome, owners, conflicts;
 *   `applied` says whether it was carried out (false on a dry run).
 */
async function moveVersion(versionUid, targetFrameUid, { dryRun = false } = {}) {
  const version = await FrameVersion.findOne({ where: { uid: versionUid }, include: versionInclude });
  if (!version) throw new NotFoundError('Frame version not found');
  const target = await frameByUid(targetFrameUid, 'Target');
  if (target.id === version.frame_id) throw new ValidationError('The version is already in that frame');
  const source = await loadFrame({ id: version.frame_id });

  const conflicts = await conflictsFor([version], target);
  const outcome   = await sourceOutcome(source, version);
  const ownerPlan = outcome === 'archived' ? await planOwners(source, target) : null;

  const changes = detailChanges(source, target);
  if (outcome !== 'archived') {
    const [losing, gaining] = await Promise.all([activeOwners(source.id), activeOwners(target.id)]);
    if (losing)  changes.push(`${losing} owner(s) of "${source.name}" lose this version`);
    if (gaining) changes.push(`${gaining} owner(s) of "${target.name}" gain this version`);
  }

  const plan = {
    version:   { uid: version.uid, version: describe(version) },
    source:    { uid: source.uid, name: source.name, outcome },
    target:    { uid: target.uid, name: target.name },
    changes,
    owners:    ownerPlan ? ownerSummary(ownerPlan) : null,
    conflicts,
    applied:   false,
  };
  if (dryRun) return plan;
  if (conflicts.length) throw new ConflictError('The version cannot join that frame', conflicts);

  await sequelize.transaction(async (transaction) => {
    await version.update({ frame_id: target.id }, { transaction });
    // Re-read inside the transaction so the owner rows applied are the current ones.
    const owners = outcome === 'archived' ? await planOwners(source, target, transaction) : null;
    await applyOutcome(source, target, outcome, owners, transaction);
  });
  plan.applied = true;
  return plan;
}

/**
 * Merge a whole frame into another: every version moves, all-or-nothing — one
 * conflict and nothing moves. The emptied source is archived and its owners follow.
 */
async function mergeFrame(sourceUid, targetUid, { dryRun = false } = {}) {
  const source = await frameByUid(sourceUid, 'Source');
  const target = await frameByUid(targetUid, 'Target');
  if (source.id === target.id) throw new ValidationError('A frame cannot be merged into itself');

  const versions  = await FrameVersion.findAll({ where: { frame_id: source.id }, include: versionInclude });
  const conflicts = await conflictsFor(versions, target);
  const plan = {
    source:    { uid: source.uid, name: source.name, outcome: 'archived', versions: versions.length },
    target:    { uid: target.uid, name: target.name },
    changes:   detailChanges(source, target),
    owners:    ownerSummary(await planOwners(source, target)),
    conflicts,
    applied:   false,
  };
  if (dryRun) return plan;
  if (conflicts.length) throw new ConflictError('The frames cannot be merged', conflicts);

  await sequelize.transaction(async (transaction) => {
    await FrameVersion.update({ frame_id: target.id }, { where: { frame_id: source.id }, transaction });
    await applyOutcome(source, target, 'archived', await planOwners(source, target, transaction), transaction);
  });
  plan.applied = true;
  return plan;
}

module.exports = { moveVersion, mergeFrame };
