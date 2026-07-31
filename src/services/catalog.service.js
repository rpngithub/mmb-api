const { Op } = require('sequelize');
const {
  BusinessCategory, TemplateCategory, AssetCategory, Tag, TemplateSize,
  ThemeGroup, Theme, Plan, FaqCategory, Faq, Testimonial, AppBanner,
} = require('../models');
const planRepo    = require('../repositories/plan.repository');
const couponRepo  = require('../repositories/coupon.repository');
const themeAccess = require('./themeAccess.service');
const { resolveRef, pick } = require('../utils/catalogRef');
const { NotFoundError } = require('../errors');

// Business-category "pill" tags shown on a theme card (display/filter attribute).
const themeBizCatInclude = { model: BusinessCategory, attributes: ['id', 'uid', 'slug', 'name'], through: { attributes: [] } };

// All reads are public-facing: only active/published rows, ordered for display.

// `parent` accepts a slug / uid / legacy int id (or 'null' for top-level); the
// legacy `parent_id` param is still honoured when `parent` is absent.
async function listBusinessCategories({ parent, parent_id } = {}) {
  const where = { is_active: 1 };
  const resolved = await resolveRef(BusinessCategory, pick(parent, parent_id));
  if (resolved !== undefined) where.parent_id = resolved;
  return BusinessCategory.findAll({ where, order: [['display_order', 'ASC'], ['name', 'ASC']] });
}

// Assemble a display-order-sorted flat list of self-referential categories into a
// parent→child forest. Each node gains a `children` array (recursive, any depth).
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

// Theme cards are a public teaser (name, description, thumbnail, likes_count,
// business-category tags); their premium templates are NEVER nested here — those
// are plan-gated behind getThemeDetail.
function listThemeGroups() {
  return ThemeGroup.findAll({
    where:   { is_active: 1 },
    order:   [['display_order', 'ASC'], [Theme, 'display_order', 'ASC']],
    include: [{ model: Theme, where: { is_active: 1 }, required: false, include: [themeBizCatInclude] }],
  });
}

// `group` accepts a slug / uid / legacy int id; legacy `group_id` still honoured.
async function listThemes({ group, group_id } = {}) {
  const where = { is_active: 1 };
  const resolved = await resolveRef(ThemeGroup, pick(group, group_id));
  if (resolved !== undefined) where.group_id = resolved;
  return Theme.findAll({
    where,
    order:   [['display_order', 'ASC'], ['name', 'ASC']],
    include: [{ model: ThemeGroup, attributes: ['id', 'uid', 'slug', 'name'] }, themeBizCatInclude],
  });
}

// Theme detail: the card is public, but its TEMPLATES are premium and gated.
// Templates are returned only when the viewer can open the theme — i.e. their active
// plan entitles them OR one of their businesses has adopted it (see themeAccess).
// Otherwise the theme comes back with `is_locked: true` and no templates (an upsell
// teaser). A theme with no plan restrictions is locked to everyone. "Theme gate
// supersedes" — an unlocked viewer gets every active template regardless of is_premium.
async function getThemeDetail(uid, viewer = null) {
  const theme = await Theme.findOne({
    where:   { uid, is_active: 1 },
    include: [
      { model: ThemeGroup, attributes: ['id', 'uid', 'slug', 'name'] },
      themeBizCatInclude,
      // Entitlement set — read to compute access, then stripped from the response.
      { model: Plan, attributes: ['id'], through: { attributes: [] } },
    ],
  });
  if (!theme) throw new NotFoundError('Theme not found');

  const allowedPlanIds = (theme.Plans || []).map((p) => p.id);
  const unlocked       = await themeAccess.isThemeUnlocked({ id: theme.id, allowedPlanIds }, viewer);

  const data = theme.toJSON();
  delete data.Plans;                 // internal entitlement set, never exposed
  data.is_locked = !unlocked;

  if (unlocked) {
    data.Templates = await theme.getTemplates({
      where:               { status: 'active' },
      attributes:          { exclude: ['created_by'] },
      joinTableAttributes: [],
      order:               [['id', 'DESC']],
    });
  }
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
// are merged in here (they have no restriction rows).
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
    return plain;
  });
}

module.exports = {
  listBusinessCategories, listTemplateCategories, listAssetCategories, listTags, listTemplateSizes,
  listThemeGroups, listThemes, getThemeDetail, listFaqCategories, listFaqs, listTestimonials,
  listBanners, listPlans,
};
