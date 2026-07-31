const { v4: uuid }    = require('uuid');
const businessRepo    = require('../repositories/business.repository');
const productRepo     = require('../repositories/product.repository');
const themeAccess     = require('./themeAccess.service');
const { Theme, Plan, Template, BusinessCategory, BusinessTheme } = require('../models');
const { resolveRef, pick } = require('../utils/catalogRef');
const { NotFoundError, ForbiddenError, ValidationError } = require('../errors');

const DEFAULT_RADIUS_KM = 10;
const MAX_RADIUS_KM     = 50;
const DEFAULT_LIMIT     = 20;
const MAX_LIMIT         = 50;

// Fields safe to expose on the public storefront (everything user-private —
// user_id, geohash, timestamps — is dropped).
const PUBLIC_FIELDS = [
  'uid', 'category_id', 'name', 'description', 'logo_s3_key', 'cover_s3_key',
  'latitude', 'longitude', 'address', 'city', 'state',
  'phone', 'whatsapp', 'email', 'website', 'social_links', 'operating_hours',
  'rating_avg', 'rating_count',
];

const num    = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const posInt = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };

function toPublic(biz) {
  const row = biz.toJSON();
  const out = {};
  for (const f of PUBLIC_FIELDS) out[f] = row[f];
  if (row.BusinessCategory) out.category = row.BusinessCategory;
  if (row.distance_km != null) out.distance_km = Math.round(row.distance_km * 100) / 100;
  return out;
}

// `industry` is the public alias for the business category: resolve it (slug / uid /
// numeric id) to the internal category_id and drop the `industry` key before writing.
// It takes precedence over a legacy `category_id`. Unknown industry -> clean 400.
async function resolveIndustry(data) {
  if (data.industry === undefined || data.industry === '') return data;
  const { industry, ...rest } = data;
  const id = await resolveRef(BusinessCategory, industry);
  if (!(typeof id === 'number' && id > 0)) throw new ValidationError('Unknown industry');
  return { ...rest, category_id: id };
}

async function createBusiness(userId, data) {
  const payload = await resolveIndustry(data);
  return businessRepo.create({ ...payload, uid: uuid(), user_id: userId });
}

async function getMyBusinesses(userId) {
  return businessRepo.findAllByUser(userId);
}

async function getBusiness(uid, userId) {
  const biz = await businessRepo.findByUid(uid);
  if (!biz) throw new NotFoundError('Business not found');
  if (biz.user_id !== userId) throw new ForbiddenError('Access denied');
  return biz;
}

async function updateBusiness(uid, userId, data) {
  const biz = await businessRepo.findByUid(uid);
  if (!biz) throw new NotFoundError('Business not found');
  if (biz.user_id !== userId) throw new ForbiddenError('Access denied');
  await businessRepo.update(biz.id, await resolveIndustry(data));
  return businessRepo.findByUid(uid);
}

async function deleteBusiness(uid, userId) {
  const biz = await businessRepo.findByUid(uid);
  if (!biz) throw new NotFoundError('Business not found');
  if (biz.user_id !== userId) throw new ForbiddenError('Access denied');
  await businessRepo.update(biz.id, { is_active: 0 });
}

// ---- Public "Near Me" directory (no auth; owner checks do not apply) ----

async function listNearby(query = {}) {
  const lat = num(query.lat);
  const lng = num(query.lng);
  if (lat === null || lat < -90 || lat > 90 || lng === null || lng < -180 || lng > 180) {
    throw new ValidationError('Valid lat and lng query params are required');
  }
  const radiusKm   = Math.min(num(query.radius) || DEFAULT_RADIUS_KM, MAX_RADIUS_KM);
  const limit      = Math.min(posInt(query.limit) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset     = Math.max(parseInt(query.offset, 10) || 0, 0);
  const sort       = query.sort === 'rating' ? 'rating' : 'distance';
  // `category` accepts a slug / uid / legacy int id; legacy `category_id` still honoured.
  // A supplied-but-unresolved ref becomes 0 → matches no businesses (rather than all).
  const catRef     = pick(query.category, query.category_id);
  const resolvedCat = await resolveRef(BusinessCategory, catRef);
  const categoryId = catRef === undefined ? null : (resolvedCat > 0 ? resolvedCat : 0);
  const q          = typeof query.q === 'string' && query.q.trim() ? query.q.trim() : null;

  const rows = await businessRepo.findNearby({ lat, lng, radiusKm, q, categoryId, sort, limit, offset });
  return rows.map(toPublic);
}

async function getPublicProfile(uid) {
  const biz = await businessRepo.findPublicByUid(uid);
  if (!biz) throw new NotFoundError('Business not found');
  return toPublic(biz);
}

async function getPublicProducts(uid) {
  const biz = await businessRepo.findPublicByUid(uid);
  if (!biz) throw new NotFoundError('Business not found');
  return productRepo.findByBusiness(biz.id);
}

// ---- "Add to your Business" — business-scoped theme adoption ----

// Lightweight template cards for the adopted collection (never the heavy `content`).
const ADOPTED_TEMPLATE_ATTRS = ['id', 'uid', 'name', 'thumbnail_s3_key', 'template_type', 'status'];

function loadThemesWithTemplates(where) {
  return Theme.findAll({
    where,
    include: [
      { model: Template,         through: { attributes: [] }, attributes: ADOPTED_TEMPLATE_ATTRS, where: { status: 'active' }, required: false },
      { model: BusinessCategory, through: { attributes: [] }, attributes: ['id', 'uid', 'slug', 'name'] },
    ],
    order: [['display_order', 'ASC'], ['name', 'ASC']],
  });
}

// Owner-checked business lookup (shared by the adoption endpoints).
async function ownedBusiness(uid, userId) {
  const biz = await businessRepo.findByUid(uid);
  if (!biz || biz.is_active !== 1) throw new NotFoundError('Business not found');
  if (biz.user_id !== userId) throw new ForbiddenError('Access denied');
  return biz;
}

// Adopt a theme into a business. Requires the owner's ACTIVE plan to entitle the theme
// (adoption itself never grants adoption). Idempotent: re-adopting is a no-op.
async function adoptTheme(userId, businessUid, themeUid) {
  const biz   = await ownedBusiness(businessUid, userId);
  const theme = await Theme.findOne({
    where: { uid: themeUid, is_active: 1 },
    include: [{ model: Plan, attributes: ['id'], through: { attributes: [] } }],
  });
  if (!theme) throw new NotFoundError('Theme not found');

  const allowedPlanIds = (theme.Plans || []).map((p) => p.id);
  if (!(await themeAccess.isPlanEntitled(allowedPlanIds, { userId }))) {
    throw new ForbiddenError('Your plan does not include this theme');
  }

  await BusinessTheme.findOrCreate({ where: { business_id: biz.id, theme_id: theme.id } });
  const [shaped] = await loadThemesWithTemplates({ id: theme.id });
  return shaped;
}

async function listAdoptedThemes(userId, businessUid) {
  const biz   = await ownedBusiness(businessUid, userId);
  const links = await BusinessTheme.findAll({ where: { business_id: biz.id }, attributes: ['theme_id'] });
  if (!links.length) return [];
  return loadThemesWithTemplates({ id: links.map((l) => l.theme_id) });
}

async function removeAdoptedTheme(userId, businessUid, themeUid) {
  const biz   = await ownedBusiness(businessUid, userId);
  const theme = await Theme.findOne({ where: { uid: themeUid } });
  if (!theme) throw new NotFoundError('Theme not found');
  await BusinessTheme.destroy({ where: { business_id: biz.id, theme_id: theme.id } });
}

module.exports = {
  createBusiness, getMyBusinesses, getBusiness, updateBusiness, deleteBusiness,
  listNearby, getPublicProfile, getPublicProducts,
  adoptTheme, listAdoptedThemes, removeAdoptedTheme,
};
