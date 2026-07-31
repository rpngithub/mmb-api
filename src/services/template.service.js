const { Op, literal } = require('sequelize');
const templateRepo = require('../repositories/template.repository');
const activityRepo = require('../repositories/activityLog.repository');
const variantAccess = require('./variantAccess.service');
const { TemplateCategory, BusinessCategory, TemplateSize, Tag } = require('../models');
const { resolveRef, resolveRefList, pick } = require('../utils/catalogRef');
const { NotFoundError, ValidationError } = require('../errors');

// Templates that belong to any variant are premium Brand Series content — they must
// never surface in the public catalog (browse or direct fetch), even via a category
// anchor. Locked variant templates ARE now listed, but only on the variant detail
// endpoint, which shows them as upsell teasers with the design payload stripped.
const NOT_A_VARIANT_MEMBER = literal(
  'NOT EXISTS (SELECT 1 FROM `variant_templates` vt WHERE vt.template_id = `Template`.`id`)',
);

const DEFAULT_LIMIT = 30;
const MAX_LIMIT     = 100;
const TEMPLATE_TYPES = ['image', 'video', 'animated'];

// Paid viewers (active subscription) get full template content; guests and free
// users get a "locked preview" — metadata only, no editable content.
const isPaidViewer = (viewer) => viewer?.tier === 'paid';

// Query params arrive as strings; coerce to a positive int or null (filter dropped).
const toPosInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Accepts "1,2,3", ["1","2"], or a single value → de-duped array of positive ints.
const toPosIntList = (v) => {
  if (v === undefined || v === null || v === '') return [];
  const parts = Array.isArray(v) ? v : String(v).split(',');
  return [...new Set(parts.map(toPosInt).filter(Boolean))];
};

// Normalize a resolveRef() result into a filter id: undefined stays undefined
// (param absent → no filter); anything that didn't resolve to a positive id
// becomes 0 so the clause matches NOTHING (a bad slug returns empty, not the
// whole catalog).
const asFilterId = (resolved) => (resolved === undefined ? undefined : (resolved > 0 ? resolved : 0));

// Membership filter against an M2M join table. EXISTS keeps pagination/ordering
// correct and avoids the duplicate rows a plain JOIN would produce. All ids are
// sanitized to positive integers above, so interpolation here is injection-safe.
const existsIn = (table, fkColumn, ids) =>
  literal(`EXISTS (SELECT 1 FROM \`${table}\` j WHERE j.template_id = \`Template\`.\`id\` ` +
          `AND j.\`${fkColumn}\` IN (${ids.join(',')}))`);

// Correlated count of a template's rows in an M2M join table — one query for the
// whole page instead of an include per relation (which would also duplicate rows).
const countIn = (table, alias) =>
  [literal(`(SELECT COUNT(*) FROM \`${table}\` j WHERE j.template_id = \`Template\`.\`id\`)`), alias];

// Completeness signals for the admin list's "incomplete" column, mirroring the
// publish gate (services/templatePublish.js) without shipping the heavy `content`
// blob: a row is publishable when it has content + a thumbnail, a category or an
// industry, and at least one size and tag. Booleans come back as MySQL 1/0.
const COMPLETENESS_ATTRS = [
  countIn('template_tags', 'tag_count'),
  countIn('template_size_map', 'size_count'),
  countIn('template_business_categories', 'industry_count'),
  [literal("(`Template`.`content` IS NOT NULL AND `Template`.`content` <> '')"), 'has_content'],
  [literal("(`Template`.`thumbnail_s3_key` IS NOT NULL AND `Template`.`thumbnail_s3_key` <> '')"), 'has_thumbnail'],
];

async function listTemplates(filters = {}, viewer = null) {
  // Anchor / narrowing filters accept a friendly slug, a uid, or a legacy int id.
  // `category` ↔ legacy `category_id`; `industry` (the public name for a business
  // category) ↔ deprecated `business_category` ↔ legacy `business_category_id`;
  // `size` ↔ `size_id`, `tags` (comma list of any of the three).
  const categoryRef = pick(filters.category, filters.category_id);
  const industryRef = pick(filters.industry, pick(filters.business_category, filters.business_category_id));

  // Public browse must be anchored: we never dump the full catalog. At least one
  // of template category / industry must be SUPPLIED (a ref that fails to resolve
  // is still an anchor — it just yields an empty page, not a 400). variant_id is
  // intentionally NOT accepted here — a variant's templates are premium and
  // plan-gated, served only via the entitlement-checked GET /variants/{uid}.
  if (categoryRef === undefined && industryRef === undefined) {
    throw new ValidationError(
      'At least one of category or industry is required',
    );
  }

  const categoryId         = asFilterId(await resolveRef(TemplateCategory, categoryRef));
  const businessCategoryId = asFilterId(await resolveRef(BusinessCategory, industryRef));
  const sizeId             = asFilterId(await resolveRef(TemplateSize, pick(filters.size, filters.size_id)));
  const tagIds             = await resolveRefList(Tag, filters.tags, { hasUid: false });

  const where = { status: 'active' };
  if (categoryId !== undefined) where.category_id = categoryId;
  if (TEMPLATE_TYPES.includes(filters.template_type)) where.template_type = filters.template_type;
  if (filters.is_premium !== undefined) where.is_premium = toPosInt(filters.is_premium) ? 1 : 0;

  // Cross-table membership filters (business category / post size / tags).
  // Always exclude variant templates from public browse (premium, plan-gated).
  const membership = [NOT_A_VARIANT_MEMBER];
  if (businessCategoryId !== undefined) membership.push(existsIn('template_business_categories', 'business_category_id', [businessCategoryId]));
  if (sizeId !== undefined)             membership.push(existsIn('template_size_map',            'size_id',              [sizeId]));
  if (tagIds.length)                    membership.push(existsIn('template_tags',                'tag_id',               tagIds));
  where[Op.and] = membership;

  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  // `content` is never returned in list responses (browse view); detail serves it.
  const rows = await templateRepo.findMany(where, {
    attributes: { exclude: ['content'] },
    order:      [['trending_score', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
  });

  const paid = isPaidViewer(viewer);
  return rows.map((row) => {
    const t = row.toJSON();
    t.is_locked = Boolean(t.is_premium) && !paid;
    return t;
  });
}

async function getTemplate(uid, viewer = null) {
  // Public endpoint: only active templates are visible — draft/inactive ones must
  // stay hidden even when the uid is known directly (mirrors the list filter).
  const tpl = await templateRepo.findOne({ uid, status: 'active' });
  if (!tpl) throw new NotFoundError('Template not found');

  // A variant template is premium, plan-gated content and is not part of the public
  // catalog: hide it entirely (404) unless the viewer is entitled or has adopted it.
  // When they may access it, the variant gate supersedes is_premium → full content.
  const access = await variantAccess.canAccessTemplate(tpl.id, viewer);
  if (access.variantGated && !access.allowed) throw new NotFoundError('Template not found');

  await templateRepo.incrementCounter(tpl.id, 'views_count');
  if (viewer?.userId) {
    await activityRepo.create({
      actor_type:  'user',
      actor_id:    viewer.userId,
      entity_type: 'template',
      entity_id:   tpl.id,
      action:      'template_view',
    });
  }

  const locked = !access.variantGated && Boolean(tpl.is_premium) && !isPaidViewer(viewer);
  const data   = tpl.toJSON();
  data.is_locked = locked;
  if (locked) delete data.content; // withhold editable content until upgrade
  return data;
}

// Admin browse: unlike the public list there is no mandatory anchor and no
// status restriction — admins see every status (filterable). Heavy `content`
// is still excluded from the list view; the detail route serves it.
async function listTemplatesForAdmin(filters = {}) {
  const where = {};
  if (['active', 'inactive', 'draft'].includes(filters.status)) where.status = filters.status;
  if (TEMPLATE_TYPES.includes(filters.template_type)) where.template_type = filters.template_type;
  if (filters.is_premium !== undefined) where.is_premium = toPosInt(filters.is_premium) ? 1 : 0;

  const categoryId = toPosInt(filters.category_id);
  if (categoryId) where.category_id = categoryId;
  if (filters.search) where.name = { [Op.like]: `%${filters.search}%` };

  const membership = [];
  // `industry_id` is the public name; `business_category_id` the deprecated alias.
  const businessCategoryId = toPosInt(filters.industry_id ?? filters.business_category_id);
  // `variant_id` is the current name; `theme_id` the deprecated alias.
  const variantId          = toPosInt(filters.variant_id ?? filters.theme_id);
  const sizeId             = toPosInt(filters.size_id);
  const tagIds             = toPosIntList(filters.tags);
  if (businessCategoryId) membership.push(existsIn('template_business_categories', 'business_category_id', [businessCategoryId]));
  if (variantId)          membership.push(existsIn('variant_templates',            'variant_id',           [variantId]));
  if (sizeId)             membership.push(existsIn('template_size_map',            'size_id',              [sizeId]));
  if (tagIds.length)      membership.push(existsIn('template_tags',                'tag_id',               tagIds));
  if (membership.length) where[Op.and] = membership;

  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  return templateRepo.findAndCountAll(where, {
    attributes: { exclude: ['content'], include: COMPLETENESS_ATTRS },
    order:      [['id', 'DESC']],
    limit,
    offset,
  });
}

module.exports = { listTemplates, getTemplate, listTemplatesForAdmin };
