const { Op } = require('sequelize');
const {
  sequelize, BusinessCategory, TemplateCategory, AssetCategory, Tag, TemplateSize,
  BrandSeries, Variant, VariantBadge, StylePersonality, Color,
  Plan, FaqCategory, Faq, Testimonial, AppBanner,
} = require('../models');
const planRepo      = require('../repositories/plan.repository');
const couponRepo    = require('../repositories/coupon.repository');
const variantAccess = require('./variantAccess.service');
const { resolveRef, pick } = require('../utils/catalogRef');
const { toCardFeatures }   = require('../utils/planFeatures');
const { NotFoundError } = require('../errors');

// Industry "pill" tags shown on a variant card (display/filter attribute).
const variantIndustryInclude = { model: BusinessCategory, attributes: ['id', 'uid', 'slug', 'name'], through: { attributes: [] } };
const variantBadgeInclude    = { model: VariantBadge, attributes: ['id', 'uid', 'slug', 'name', 'icon_s3_key'] };

// The three descriptive collections on a Brand Series. `through` carries display_order
// for the ordered ones so the palette and strapline render in the intended sequence.
const seriesStyleInclude = { model: StylePersonality, attributes: ['id', 'uid', 'slug', 'name'], through: { attributes: ['display_order'] } };
const seriesTagInclude   = { model: Tag,              attributes: ['id', 'slug', 'name'],        through: { attributes: [] } };
const seriesColorInclude = { model: Color,            attributes: ['id', 'uid', 'slug', 'name', 'hex_code'], through: { attributes: ['display_order'] } };
const seriesIncludes     = [seriesStyleInclude, seriesTagInclude, seriesColorInclude];

const DEFAULT_PREVIEW_VARIANTS = 4;

// Sort the two ordered M2Ms by their join-table display_order, then drop the join
// payload — Sequelize can't ORDER BY a through column on a nested include.
function sortSeriesCollections(plain) {
  for (const [key, through] of [['StylePersonalities', 'BrandSeriesStylePersonality'], ['Colors', 'BrandSeriesColor']]) {
    if (!Array.isArray(plain[key])) continue;
    plain[key] = plain[key]
      .sort((a, b) => (a[through]?.display_order ?? 0) - (b[through]?.display_order ?? 0))
      .map(({ [through]: _drop, ...rest }) => rest);
  }
  return plain;
}

// Distinct ACTIVE template counts, grouped by variant and by series. One query each,
// regardless of how many rows are being listed. Series-level counts are DISTINCT across
// the whole series: a template shared by two variants of one series is counted once.
async function templateCounts(seriesIds, variantIds) {
  const byVariant = new Map();
  const bySeries  = new Map();

  if (variantIds.length) {
    const [rows] = await sequelize.query(
      `SELECT vt.variant_id AS k, COUNT(DISTINCT vt.template_id) AS n
         FROM variant_templates vt
         JOIN templates t ON t.id = vt.template_id AND t.status = 'active'
        WHERE vt.variant_id IN (:ids)
        GROUP BY vt.variant_id`,
      { replacements: { ids: variantIds } },
    );
    rows.forEach((r) => byVariant.set(Number(r.k), Number(r.n)));
  }

  if (seriesIds.length) {
    const [rows] = await sequelize.query(
      `SELECT v.series_id AS k, COUNT(DISTINCT vt.template_id) AS n
         FROM variant_templates vt
         JOIN variants   v ON v.id = vt.variant_id AND v.is_active = 1
         JOIN templates  t ON t.id = vt.template_id AND t.status = 'active'
        WHERE v.series_id IN (:ids)
        GROUP BY v.series_id`,
      { replacements: { ids: seriesIds } },
    );
    rows.forEach((r) => bySeries.set(Number(r.k), Number(r.n)));
  }

  return { byVariant, bySeries };
}

// All reads are public-facing: only active/published rows, ordered for display.

// `parent` accepts a slug / uid / legacy int id (or 'null' for top-level); the
// legacy `parent_id` param is still honoured when `parent` is absent.
// Two shape switches, both taking any value (`=1` by convention):
//   tree      — the whole active forest nested parent→child, any depth
//   hierarchy — only the top-level industries (no parent), flat
// `tree` wins if both are sent, and either one ignores `parent`/`parent_id`
// since the shape already decides which rows come back.
async function listBusinessCategories({ parent, parent_id, tree, hierarchy } = {}) {
  const where = { is_active: 1 };
  const order = [['display_order', 'ASC'], ['name', 'ASC']];

  if (tree !== undefined)      return buildCategoryTree(await BusinessCategory.findAll({ where, order }));
  if (hierarchy !== undefined) return BusinessCategory.findAll({ where: { ...where, parent_id: null }, order });

  const resolved = await resolveRef(BusinessCategory, pick(parent, parent_id));
  if (resolved !== undefined) where.parent_id = resolved;
  return BusinessCategory.findAll({ where, order });
}

// Assemble a display-order-sorted flat list of self-referential categories into a
// parent→child forest. Shared by industries and template categories. Each node
// gains a `children` array (recursive, any depth).
// Rows arrive already sorted by display_order ASC, so both roots and every
// children[] preserve that order. A node whose parent is absent from the set
// (e.g. filtered out by `homepage`) is surfaced as a root so nothing is dropped.
function buildCategoryTree(rows) {
  const nodes = new Map(rows.map((r) => [r.id, { ...r.toJSON(), children: [] }]));
  const roots = [];
  for (const row of rows) {
    const parent = row.parent_id != null ? nodes.get(row.parent_id) : null;
    (parent ? parent.children : roots).push(nodes.get(row.id));
  }
  return roots;
}

// `parent` accepts a slug / uid / legacy int id (or 'null' for top-level);
// legacy `parent_id` still honoured. Combinable with `homepage`.
// `tree` (any value) returns the full active forest nested parent→child instead
// of a flat list — every level ordered by display_order ASC. In tree mode the
// flat `parent`/`parent_id` filter is ignored (the whole hierarchy is returned).
async function listTemplateCategories({ homepage, parent, parent_id, tree } = {}) {
  const where = { is_active: 1 };
  if (homepage !== undefined) where.show_in_homepage = 1;

  if (tree !== undefined) {
    const rows = await TemplateCategory.findAll({ where, order: [['display_order', 'ASC'], ['name', 'ASC']] });
    return buildCategoryTree(rows);
  }

  const resolved = await resolveRef(TemplateCategory, pick(parent, parent_id));
  if (resolved !== undefined) where.parent_id = resolved;
  return TemplateCategory.findAll({ where, order: [['display_order', 'ASC'], ['name', 'ASC']] });
}

async function listAssetCategories({ parent, parent_id } = {}) {
  const where = { is_active: 1 };
  const resolved = await resolveRef(AssetCategory, pick(parent, parent_id));
  if (resolved !== undefined) where.parent_id = resolved;
  return AssetCategory.findAll({ where, order: [['display_order', 'ASC'], ['name', 'ASC']] });
}

function listTags() {
  return Tag.findAll({ order: [['name', 'ASC']] });
}

function listTemplateSizes() {
  return TemplateSize.findAll({ where: { is_active: 1 }, order: [['platform', 'ASC'], ['name', 'ASC']] });
}

// Brand Series list. Each series carries its descriptive collections, a preview slice of
// its variants (the list page shows a handful of cards, not all ten), and the counts the
// card renders — "10 VARIANTS", "8 Ready-to-Use Templates".
//
// `is_locked` here is a ROLLUP, not a gate of its own: gating lives on the variants, so a
// series reads as locked only when every one of its variants is. `unlocked_variants_count`
// lets the frontend distinguish "Unlock" from a partially-owned series.
//
// Variants are fetched in one query and sliced per series in JS — a per-series LIMIT isn't
// expressible in a single Sequelize include, and the counts have to come off the full set.
async function listBrandSeries({ preview_variants } = {}, viewer = null) {
  const previewLimit = preview_variants === undefined
    ? DEFAULT_PREVIEW_VARIANTS
    : Math.max(0, parseInt(preview_variants, 10) || 0);

  const series = await BrandSeries.findAll({
    where:   { is_active: 1 },
    order:   [['display_order', 'ASC'], ['name', 'ASC']],
    include: seriesIncludes,
  });
  if (!series.length) return [];

  const seriesIds = series.map((s) => s.id);
  const variants  = await Variant.findAll({
    where:   { is_active: 1, series_id: { [Op.in]: seriesIds } },
    order:   [['display_order', 'ASC'], ['name', 'ASC']],
    include: [variantBadgeInclude, variantIndustryInclude],
  });

  const variantIds = variants.map((v) => v.id);
  const counts     = await templateCounts(seriesIds, variantIds);
  const unlocked   = await variantAccess.unlockedVariantIds(variantIds, viewer);

  const bySeries = new Map(seriesIds.map((id) => [id, []]));
  for (const v of variants) bySeries.get(v.series_id).push(v);

  return series.map((s) => {
    const own   = bySeries.get(s.id) || [];
    const plain = sortSeriesCollections(s.toJSON());

    plain.variants_count          = own.length;
    plain.templates_count         = counts.bySeries.get(s.id) || 0;
    plain.unlocked_variants_count = own.filter((v) => unlocked.has(v.id)).length;
    // No variants at all reads as locked: there is nothing to open.
    plain.is_locked               = plain.unlocked_variants_count === 0;
    plain.Variants                = own.slice(0, previewLimit).map((v) => ({
      ...v.toJSON(),
      templates_count: counts.byVariant.get(v.id) || 0,
      is_locked:       !unlocked.has(v.id),
    }));
    return plain;
  });
}

// `series` accepts a slug / uid / legacy int id; the older `group` / `group_id` params are
// still honoured (see the deprecated aliases on the router).
async function listVariants({ series, series_id, group, group_id } = {}, viewer = null) {
  const where    = { is_active: 1 };
  const resolved = await resolveRef(BrandSeries, pick(series, series_id, group, group_id));
  if (resolved !== undefined) where.series_id = resolved;

  const rows = await Variant.findAll({
    where,
    order:   [['display_order', 'ASC'], ['name', 'ASC']],
    include: [
      { model: BrandSeries, attributes: ['id', 'uid', 'slug', 'name', 'icon_s3_key', 'caption'] },
      variantBadgeInclude,
      variantIndustryInclude,
    ],
  });

  const ids      = rows.map((r) => r.id);
  const counts   = await templateCounts([], ids);
  const unlocked = await variantAccess.unlockedVariantIds(ids, viewer);

  return rows.map((r) => ({
    ...r.toJSON(),
    templates_count: counts.byVariant.get(r.id) || 0,
    is_locked:       !unlocked.has(r.id),
  }));
}

// Variant detail. The card is public AND — unlike the previous behaviour — so is the
// template list: locked templates are now returned as visible upsell teasers rather than
// withheld, so an unauthorised viewer can see what they'd be buying before subscribing.
//
// What a locked viewer gets is a THUMBNAIL ONLY: `content` (the design payload) is
// stripped, so the artwork itself stays behind the paywall. The hard gate is untouched —
// opening a template or starting a project still fails in variantAccess.canAccessTemplate.
//
// A variant with no plan restrictions is locked to everyone. "Variant gate supersedes" —
// an unlocked viewer gets every active template regardless of is_premium.
async function getVariantDetail(uid, viewer = null) {
  const variant = await Variant.findOne({
    where:   { uid, is_active: 1 },
    include: [
      { model: BrandSeries, attributes: ['id', 'uid', 'slug', 'name', 'icon_s3_key', 'caption', 'description'], include: seriesIncludes },
      variantBadgeInclude,
      variantIndustryInclude,
      // Entitlement set — read to compute access, then stripped from the response.
      { model: Plan, attributes: ['id'], through: { attributes: [] } },
    ],
  });
  if (!variant) throw new NotFoundError('Variant not found');

  const allowedPlanIds = (variant.Plans || []).map((p) => p.id);
  const unlocked       = await variantAccess.isVariantUnlocked({ id: variant.id, allowedPlanIds }, viewer);

  const data = variant.toJSON();
  delete data.Plans;                 // internal entitlement set, never exposed
  data.is_locked = !unlocked;
  if (data.BrandSeries) data.BrandSeries = sortSeriesCollections(data.BrandSeries);

  const templates = await variant.getTemplates({
    where:               { status: 'active' },
    attributes:          { exclude: ['created_by', ...(unlocked ? [] : ['content'])] },
    joinTableAttributes: [],
    order:               [['id', 'DESC']],
  });
  data.Templates       = templates.map((t) => ({ ...t.toJSON(), is_locked: !unlocked }));
  data.templates_count = templates.length;

  return data;
}

function listFaqCategories() {
  return FaqCategory.findAll({
    where:   { status: 'active' },
    order:   [['display_order', 'ASC'], [Faq, 'display_order', 'ASC']],
    include: [{ model: Faq, where: { status: 'active' }, required: false }],
  });
}

// FAQs are returned grouped under their category — categories ordered by
// display_order, FAQs within each by display_order. Categories are a
// future-scale option: FAQs created without one (category_id null) are kept
// and returned in a trailing { id: null, name: null } group, so the endpoint
// works whether or not categories are in use. Optional category_id narrows to
// a single group.
async function listFaqs({ category, category_id } = {}) {
  const where = { status: 'active' };
  // `category` accepts a slug / uid / legacy int id ('null' narrows to the
  // uncategorized group); legacy `category_id` still honoured.
  const resolved = await resolveRef(FaqCategory, pick(category, category_id));
  if (resolved !== undefined) where.category_id = resolved;
  const faqs = await Faq.findAll({
    where,
    order:   [['display_order', 'ASC'], ['id', 'ASC']],
    include: [{ model: FaqCategory, attributes: ['id', 'uid', 'slug', 'name', 'display_order'] }],
  });

  // Bucket by category, preserving each FAQ's display_order sequence.
  const groups = new Map();
  for (const faq of faqs) {
    const cat = faq.FaqCategory;
    const key = cat ? cat.id : null;
    if (!groups.has(key)) {
      groups.set(key, {
        id:            cat ? cat.id : null,
        uid:           cat ? cat.uid : null,
        slug:          cat ? cat.slug : null,
        name:          cat ? cat.name : null,
        display_order: cat ? cat.display_order : null,
        Faqs:          [],
      });
    }
    groups.get(key).Faqs.push(faq);
  }

  // Categories by display_order; the uncategorized (null) group always last.
  return [...groups.values()].sort((a, b) => {
    if (a.id === null) return 1;
    if (b.id === null) return -1;
    return a.display_order - b.display_order;
  });
}

function listTestimonials() {
  return Testimonial.findAll({ where: { status: 'active' }, order: [['display_order', 'ASC'], ['created_at', 'DESC']] });
}

// Banners are time-windowed and audience-targeted by the viewer's tier.
function listBanners(viewer = null) {
  const now      = new Date();
  const audience = viewer?.tier === 'paid' ? 'paid_users' : 'free_users';
  return AppBanner.findAll({
    where: {
      status:          'active',
      target_audience: { [Op.in]: ['all', audience] },
      starts_at:       { [Op.lte]: now },
      [Op.or]: [{ ends_at: null }, { ends_at: { [Op.gte]: now } }],
    },
    order: [['starts_at', 'DESC']],
  });
}

// Pricing is public catalog data; delegate to plan.repository for the active-only
// + billing-options + card-feature shaping. Filters: plan_type (default
// 'subscription') and billing_option_type (monthly|annual). Each plan carries a
// `coupons` array — specific-plan coupons come from the join, all-plans coupons
// are merged in here (they have no restriction rows) — and a `features` array,
// which replaces the raw `PlanFeatures` join rows with the card-ready shape (see
// utils/planFeatures): a label that is never null, plus an on/off flag.
async function listPlans({ plan_type, billing_option_type } = {}) {
  const filters = {
    plan_type:           ['subscription', 'access_pass'].includes(plan_type) ? plan_type : 'subscription',
    billing_option_type: ['monthly', 'annual'].includes(billing_option_type) ? billing_option_type : undefined,
  };

  const [plans, globalCoupons] = await Promise.all([
    planRepo.findAllActive(filters),
    couponRepo.findActivePublicGlobal(),
  ]);

  return plans.map((p) => {
    const plain    = p.toJSON();
    const specific = plain.coupons || [];
    const seen     = new Set(specific.map((c) => c.uid));
    plain.coupons  = [...specific, ...globalCoupons.filter((c) => !seen.has(c.uid))];
    plain.features = toCardFeatures(plain.PlanFeatures);
    delete plain.PlanFeatures;
    return plain;
  });
}

module.exports = {
  listBusinessCategories, listTemplateCategories, listAssetCategories, listTags, listTemplateSizes,
  listBrandSeries, listVariants, getVariantDetail, listFaqCategories, listFaqs, listTestimonials,
  listBanners, listPlans,
};
