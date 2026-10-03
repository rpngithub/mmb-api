const { Op, literal, QueryTypes } = require('sequelize');
const {
  sequelize, UserFavouriteTemplate, UserFavouriteAsset, TemplateFamily, Asset, AssetCategory, VariantTemplate,
} = require('../models');
const activityRepo  = require('../repositories/activityLog.repository');
const variantAccess = require('./variantAccess.service');
const picker        = require('./templateFamilyPicker');
const { lockAsset } = require('../utils/assetLock');
const { ASSET_TYPES } = require('../utils/assetTypes');
const { NotFoundError, ValidationError } = require('../errors');

// My Favourites — designs (template families) and assets a user has hearted.
//
//   add / remove  idempotent: a second add or a remove of something not saved is a
//                 200, so the app's heart button can retry blindly.
//   who may add   exactly who may OPEN it: an active design the viewer can access
//                 (variant designs only when unlocked — canAccessFamily), or an
//                 active asset. Locked PREMIUM items may be saved: a wishlist is an
//                 upsell, and they stay locked in the list.
//   the list      shows what is still openable, newest first. A design that goes
//                 inactive, or a variant design whose plan lapsed, drops out of the
//                 list but its row is KEPT — it comes back if access does.
//   likes_count   on the design = the number of favourites, moved ±1 only when a
//                 row was actually inserted or deleted, so retries cannot drift it.

const DEFAULT_TEMPLATE_LIMIT = 30;
const DEFAULT_ASSET_LIMIT    = 50;
const MAX_LIMIT              = 100;

const isPaidViewer = (viewer) => viewer?.tier === 'paid';

const page = (filters, defaultLimit) => ({
  limit:  Math.min(parseInt(filters.limit, 10) || defaultLimit, MAX_LIMIT),
  offset: Math.max(parseInt(filters.offset, 10) || 0, 0),
});

const FAV_FAMILY = '`UserFavouriteTemplate`.`family_id`';

async function likesCount(familyId, transaction) {
  const row = await TemplateFamily.findByPk(familyId, { attributes: ['likes_count'], transaction });
  return row ? Number(row.likes_count) || 0 : 0;
}

// ---- Templates (designs) ----

async function addTemplate(familyUid, viewer) {
  const family = await TemplateFamily.findOne({ where: { uid: familyUid, status: 'active' }, attributes: ['id'] });
  if (!family) throw new NotFoundError('Template not found');

  // Same hard gate as opening it: a variant design the viewer cannot open is a 404,
  // not a 403 — its existence is not public.
  const access = await variantAccess.canAccessFamily(family.id, viewer);
  if (!access.allowed) throw new NotFoundError('Template not found');

  // A design with no active version cannot be opened either. The picked version is
  // also what the like is logged against: activity names versions, and the trending
  // job rolls them up to the design.
  const languageIds = await picker.resolveLanguageRank({}, viewer);
  const defaultSize = await picker.defaultSizeId();
  const chosen = (await picker.pickVersions([family.id], { languageIds, defaultSize, hide: false })).get(family.id);
  if (!chosen) throw new NotFoundError('Template not found');

  return sequelize.transaction(async (transaction) => {
    const [, inserted] = await sequelize.query(
      'INSERT IGNORE INTO `user_favourite_templates` (`user_id`, `family_id`, `created_at`) VALUES (?, ?, NOW())',
      { replacements: [viewer.userId, family.id], type: QueryTypes.INSERT, transaction },
    );
    if (inserted) {
      await TemplateFamily.update({ likes_count: literal('`likes_count` + 1') }, { where: { id: family.id }, transaction });
      await activityRepo.create({
        actor_type:  'user',
        actor_id:    viewer.userId,
        entity_type: 'template',
        entity_id:   chosen.version.id,
        action:      'template_like',
      }, transaction);
    }
    return { favourited: true, likes_count: await likesCount(family.id, transaction) };
  });
}

// Works whatever the design's status — un-hearting something that has since gone
// inactive must still be possible.
async function removeTemplate(familyUid, viewer) {
  const family = await TemplateFamily.findOne({ where: { uid: familyUid }, attributes: ['id'] });
  if (!family) throw new NotFoundError('Template not found');

  return sequelize.transaction(async (transaction) => {
    const removed = await UserFavouriteTemplate.destroy({ where: { user_id: viewer.userId, family_id: family.id }, transaction });
    if (removed) {
      await TemplateFamily.update(
        { likes_count: literal('GREATEST(`likes_count` - 1, 0)') },
        { where: { id: family.id }, transaction },
      );
    }
    return { favourited: false, likes_count: await likesCount(family.id, transaction) };
  });
}

/**
 * The viewer's saved designs as feed cards, newest favourite first. Each card is
 * the version picked for the viewer like the feed's, but a saved design is never
 * hidden for language (hide:false) — it opens in its best version instead.
 */
async function listTemplates(filters = {}, viewer) {
  const { limit, offset } = page(filters, DEFAULT_TEMPLATE_LIMIT);

  // Variant designs are listed only while the viewer can still open them. Resolve
  // that up front, over just this user's saved variant designs, so the visibility
  // rule is SQL and pagination stays exact.
  const savedVariantRows = await VariantTemplate.findAll({
    where: {
      family_id: {
        [Op.in]: literal(`(SELECT f.family_id FROM \`user_favourite_templates\` f WHERE f.user_id = ${Number(viewer.userId)})`),
      },
    },
    attributes: ['family_id', 'variant_id'],
    raw: true,
  });
  const unlocked = await variantAccess.unlockedVariantIds(savedVariantRows.map((r) => r.variant_id), viewer);
  const allowedVariantFamilies = [...new Set(savedVariantRows.filter((r) => unlocked.has(r.variant_id)).map((r) => r.family_id))];

  const notVariant = `NOT EXISTS (SELECT 1 FROM \`variant_templates\` vt WHERE vt.family_id = ${FAV_FAMILY})`;
  const visible = allowedVariantFamilies.length
    ? `(${notVariant} OR ${FAV_FAMILY} IN (${allowedVariantFamilies.map(Number).join(',')}))`
    : notVariant;

  const result = await UserFavouriteTemplate.findAndCountAll({
    where: {
      user_id: viewer.userId,
      [Op.and]: [literal(visible), picker.versionMatchClause(FAV_FAMILY, {})],
    },
    include: [{ model: TemplateFamily, required: true, where: { status: 'active' } }],
    order:   [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
  });

  const gated = new Set(allowedVariantFamilies);
  const savedAt = new Map(result.rows.map((r) => [r.family_id, r.created_at]));
  const paid = isPaidViewer(viewer);
  const languageIds = await picker.resolveLanguageRank(filters, viewer);

  // A variant design the viewer may open is served in full (the variant gate
  // supersedes is_premium), exactly as GET /templates/:uid does.
  const cards = await picker.familiesToCards(
    result.rows.map((r) => r.TemplateFamily),
    { languageIds, hide: false },
    (f) => !gated.has(f.id) && Boolean(f.is_premium) && !paid,
  );
  for (const card of cards) {
    card.is_favourited  = true;
    card.favourited_at  = savedAt.get(card.family_id);
  }
  return { total: result.count, items: cards };
}

// ---- Assets ----

async function addAsset(assetUid, viewer) {
  const asset = await Asset.findOne({ where: { uid: assetUid, status: 'active' }, attributes: ['id'] });
  if (!asset) throw new NotFoundError('Asset not found');

  await sequelize.query(
    'INSERT IGNORE INTO `user_favourite_assets` (`user_id`, `asset_id`, `created_at`) VALUES (?, ?, NOW())',
    { replacements: [viewer.userId, asset.id], type: QueryTypes.INSERT },
  );
  return { favourited: true };
}

async function removeAsset(assetUid, viewer) {
  const asset = await Asset.findOne({ where: { uid: assetUid }, attributes: ['id'] });
  if (!asset) throw new NotFoundError('Asset not found');

  await UserFavouriteAsset.destroy({ where: { user_id: viewer.userId, asset_id: asset.id } });
  return { favourited: false };
}

// Saved assets, newest first; inactive ones drop out (rows kept). Locked premium
// assets keep their thumbnail and lose `s3_key`, as in the browse.
async function listAssets(filters = {}, viewer) {
  const { limit, offset } = page(filters, DEFAULT_ASSET_LIMIT);

  const assetWhere = { status: 'active' };
  if (filters.asset_type !== undefined && filters.asset_type !== '') {
    if (!ASSET_TYPES.includes(filters.asset_type)) {
      throw new ValidationError(`asset_type must be one of: ${ASSET_TYPES.join(', ')}`);
    }
    assetWhere.asset_type = filters.asset_type;
  }

  const result = await UserFavouriteAsset.findAndCountAll({
    where:   { user_id: viewer.userId },
    include: [{
      model: Asset, required: true, where: assetWhere,
      include: [{ model: AssetCategory, attributes: ['id', 'uid', 'slug', 'name'] }],
    }],
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  const paid = isPaidViewer(viewer);
  const items = result.rows.map((row) => {
    const a = row.Asset.toJSON();
    a.is_locked     = Boolean(a.is_premium) && !paid;
    a.is_favourited = true;
    a.favourited_at = row.created_at;
    return a.is_locked ? lockAsset(a) : a;
  });
  return { total: result.count, items };
}

// ---- Flags on other reads ----

/**
 * Stamp `is_favourited` on rows served to a signed-in viewer — one query per page.
 * Guests get no field at all (there is nothing they could have saved).
 *
 * @param {object|object[]} rows  template cards (keyed by family_id) or assets (by id)
 * @param {'template'|'asset'} kind
 */
async function markFavourited(rows, viewer, kind) {
  if (!viewer?.userId) return rows;
  const list = Array.isArray(rows) ? rows : [rows];
  const key  = kind === 'template' ? 'family_id' : 'id';
  const ids  = [...new Set(list.map((r) => r[key]).filter(Boolean))];
  if (!ids.length) return rows;

  const saved = kind === 'template'
    ? await UserFavouriteTemplate.findAll({ where: { user_id: viewer.userId, family_id: { [Op.in]: ids } }, attributes: ['family_id'], raw: true })
    : await UserFavouriteAsset.findAll({ where: { user_id: viewer.userId, asset_id: { [Op.in]: ids } }, attributes: ['asset_id'], raw: true });
  const set = new Set(saved.map((r) => (kind === 'template' ? r.family_id : r.asset_id)));

  for (const r of list) r.is_favourited = set.has(r[key]);
  return rows;
}

// ---- Housekeeping (merge, purge) ----

// Recount likes_count from the rows themselves — for the paths where ±1 bookkeeping
// cannot be exact (merging two designs a user may have hearted both of).
async function recountLikes(familyIds, transaction) {
  const ids = [...new Set(familyIds.map(Number).filter(Boolean))];
  if (!ids.length) return;
  await sequelize.query(
    `UPDATE \`template_families\` tf
        SET tf.likes_count = (SELECT COUNT(*) FROM \`user_favourite_templates\` f WHERE f.family_id = tf.id)
      WHERE tf.id IN (${ids.join(',')})`,
    { transaction },
  );
}

// Move every heart from one design to another (family merge). A user who had both
// keeps one; then both counters are recounted.
async function moveTemplateFavourites(sourceFamilyId, targetFamilyId, transaction) {
  await sequelize.query(
    `INSERT IGNORE INTO \`user_favourite_templates\` (\`user_id\`, \`family_id\`, \`created_at\`)
     SELECT \`user_id\`, ?, \`created_at\` FROM \`user_favourite_templates\` WHERE \`family_id\` = ?`,
    { replacements: [targetFamilyId, sourceFamilyId], transaction },
  );
  await UserFavouriteTemplate.destroy({ where: { family_id: sourceFamilyId }, transaction });
  await recountLikes([sourceFamilyId, targetFamilyId], transaction);
}

// Delete a user's favourites (account purge), taking their hearts off the counters.
async function purgeUser(userId, transaction) {
  const saved = await UserFavouriteTemplate.findAll({ where: { user_id: userId }, attributes: ['family_id'], raw: true, transaction });
  await UserFavouriteTemplate.destroy({ where: { user_id: userId }, transaction });
  await UserFavouriteAsset.destroy({ where: { user_id: userId }, transaction });
  await recountLikes(saved.map((r) => r.family_id), transaction);
}

module.exports = {
  addTemplate, removeTemplate, listTemplates,
  addAsset, removeAsset, listAssets,
  markFavourited, moveTemplateFavourites, recountLikes, purgeUser,
};
