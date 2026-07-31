const { Op, literal } = require('sequelize');
const assetRepo = require('../repositories/asset.repository');
const { AssetCategory, Tag } = require('../models');
const { resolveRef, resolveRefList, pick } = require('../utils/catalogRef');
const { ValidationError } = require('../errors');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 100;
const ASSET_TYPES   = ['icon', 'emoji', 'shape', 'font', 'audio', 'video', 'animated', 'bg'];

// Paid viewers get the asset file (s3_key); guests/free see premium assets locked.
const isPaidViewer = (viewer) => viewer?.tier === 'paid';

// Tag membership via the asset_tags join. EXISTS keeps pagination correct and
// avoids duplicate rows; tag ids are resolved to ints below (injection-safe).
const existsTags = (ids) =>
  literal(`EXISTS (SELECT 1 FROM \`asset_tags\` j WHERE j.asset_id = \`Asset\`.\`id\` ` +
          `AND j.\`tag_id\` IN (${ids.join(',')}))`);

async function listAssets(filters = {}, viewer = null) {
  // Category is the required anchor — assets are browsed within a category. `category`
  // accepts a slug / uid / legacy int id; legacy `category_id` still honoured. A
  // supplied-but-unresolved ref yields an empty page (id 0), not a 400.
  const categoryRef = pick(filters.category, filters.category_id);
  if (categoryRef === undefined) throw new ValidationError('category is required');

  const resolved = await resolveRef(AssetCategory, categoryRef);
  const categoryId = (typeof resolved === 'number' && resolved > 0) ? resolved : 0;

  const where = { status: 'active', category_id: categoryId };
  if (ASSET_TYPES.includes(filters.asset_type)) where.asset_type = filters.asset_type;

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
    if (a.is_locked) delete a.s3_key; // withhold the file until upgrade
    return a;
  });
}

module.exports = { listAssets };
