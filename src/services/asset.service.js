const { Op, literal } = require('sequelize');
const assetRepo = require('../repositories/asset.repository');
const { AssetCategory, Tag } = require('../models');
const { resolveRef, resolveRefList, pick } = require('../utils/catalogRef');
const { ASSET_TYPES } = require('../utils/assetTypes');
const { ValidationError } = require('../errors');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 100;

// Paid viewers get the asset file (s3_key); guests/free see premium assets locked.
const isPaidViewer = (viewer) => viewer?.tier === 'paid';

// What a locked row keeps. `s3_key` is the deliverable and goes; `thumbnail_s3_key`
// is the browse image and STAYS — the lock is meant to stop the file being used,
// not to stop the asset being seen. A locked card with nothing to draw is the
// reason this column exists, so withholding it here would defeat it.
//
// This only holds because the thumbnail is a degraded copy by construction (see
// the migration and upload.service's `asset_thumbnail` slot). Store the original's
// key in that column and the delete below stops protecting anything.
const lock = (a) => { delete a.s3_key; return a; };

// Tag membership via the asset_tags join. EXISTS keeps pagination correct and
// avoids duplicate rows; tag ids are resolved to ints below (injection-safe).
const existsTags = (ids) =>
  literal(`EXISTS (SELECT 1 FROM \`asset_tags\` j WHERE j.asset_id = \`Asset\`.\`id\` ` +
          `AND j.\`tag_id\` IN (${ids.join(',')}))`);

async function listAssets(filters = {}, viewer = null) {
  // EITHER `category` OR `asset_type` anchors the browse — at least one is required.
  // Neither is individually mandatory, but an unanchored call would list the whole
  // library, so it is refused. Two anchors instead of one because assets with no
  // category exist (the column is nullable, and both the admin create and the CSV
  // import leave it optional) and a category-only endpoint could never reach them.
  const categoryRef = pick(filters.category, filters.category_id);
  const hasCategory = categoryRef !== undefined;
  const hasType     = filters.asset_type !== undefined && filters.asset_type !== '';
  if (!hasCategory && !hasType) {
    throw new ValidationError('at least one of category or asset_type is required');
  }

  const where = { status: 'active' };

  // `category` accepts a slug / uid / legacy int id; legacy `category_id` still
  // honoured. A supplied-but-unresolved ref filters to the empty set (id 0) rather
  // than being dropped — a typo'd slug must not silently widen the results. Since
  // the filter is now optional, absent and unresolved must stay distinguishable:
  // collapsing them would turn `?category=typo` into "every asset".
  if (hasCategory) {
    const resolved = await resolveRef(AssetCategory, categoryRef);
    // `null` is resolveRef's literal-'null' form, and here means "uncategorized".
    where.category_id = (resolved === null || (typeof resolved === 'number' && resolved > 0))
      ? resolved
      : 0;
  }

  // Validated strictly rather than ignored-if-unknown: as an anchor, a silently
  // dropped `?asset_type=icons` would return the entire library.
  if (hasType) {
    if (!ASSET_TYPES.includes(filters.asset_type)) {
      throw new ValidationError(`asset_type must be one of: ${ASSET_TYPES.join(', ')}`);
    }
    where.asset_type = filters.asset_type;
  }

  // `tags` — each a slug / uid / legacy id; matches assets carrying ANY of them.
  const tagIds = await resolveRefList(Tag, filters.tags, { hasUid: false });
  if (tagIds.length) where[Op.and] = [existsTags(tagIds)];

  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const rows = await assetRepo.findMany(where, {
    include: [{ model: AssetCategory, attributes: ['id', 'uid', 'slug', 'name'] }],
    order:   [['id', 'DESC']],
    limit,
    offset,
  });

  const paid = isPaidViewer(viewer);
  return rows.map((row) => {
    const a = row.toJSON();
    a.is_locked = Boolean(a.is_premium) && !paid;
    return a.is_locked ? lock(a) : a;   // withhold the file until upgrade
  });
}

module.exports = { listAssets };
