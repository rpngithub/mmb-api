const { Op }          = require('sequelize');
const { v4: uuid }    = require('uuid');
const businessRepo    = require('../repositories/business.repository');
const productRepo     = require('../repositories/product.repository');
const userRepo        = require('../repositories/user.repository');
const userUpload      = require('./userUpload.service');
const quota           = require('./quota.service');
const productService  = require('./product.service');
const fontService     = require('./font.service');
const variantAccess   = require('./variantAccess.service');
const { sequelize, Variant, VariantBadge, Plan, Template, Tag, Font, BusinessCategory, BusinessVariant } = require('../models');
const { resolveRef, pick } = require('../utils/catalogRef');
const slugify         = require('../utils/slugify');
const { NotFoundError, ForbiddenError, ValidationError, ConflictError } = require('../errors');

const DEFAULT_RADIUS_KM = 10;
const MAX_RADIUS_KM     = 50;
const DEFAULT_LIMIT     = 20;
const MAX_LIMIT         = 50;

// One business per user for now. Kept as a constant (and the list endpoint kept
// returning an array) so raising the cap later is a one-line change that breaks
// no client.
const MAX_BUSINESSES_PER_USER = 1;

// What the owner sees on their own business: the industry with its moderation
// state (so the app can render "pending approval" on a suggested sub-industry)
// and their keyword picks.
// Brand Kit typography on the owner's own read, so the settings screen can label
// the picked families without a second call.
const FONT_ATTRS = ['id', 'uid', 'family', 'is_premium'];

const OWNER_INCLUDE = [
  { model: BusinessCategory, attributes: ['id', 'uid', 'slug', 'name', 'parent_id', 'status', 'is_active'] },
  { model: Tag, attributes: ['id', 'name', 'slug'], through: { attributes: [] } },
  { model: Font, as: 'headingFont', attributes: FONT_ATTRS },
  { model: Font, as: 'bodyFont',    attributes: FONT_ATTRS },
];

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

  // A user-suggested sub-industry is invisible to the public until an admin
  // approves it: drop the chip AND the id, so nothing about the pending row
  // leaks. The business itself still lists normally — only the label is held
  // back, and it appears on approval with no further write.
  const cat = row.BusinessCategory;
  if (cat && cat.status === 'approved' && cat.is_active === 1) {
    out.category = { id: cat.id, uid: cat.uid, slug: cat.slug, name: cat.name };
  } else {
    out.category_id = null;
  }

  if (row.distance_km != null) out.distance_km = Math.round(row.distance_km * 100) / 100;
  return out;
}

// ---- Industry, sub-industry & the "Others" suggestion ----

// Resolves a friendly ref (slug / uid / numeric id) to a PUBLISHED industry row.
// Pending and retired rows are deliberately unresolvable: a client can only
// attach to an industry the catalogue actually offers. Returns null when the ref
// matches nothing usable.
async function findPublishedIndustry(ref, transaction) {
  const id = await resolveRef(BusinessCategory, ref);
  if (!(typeof id === 'number' && id > 0)) return null;
  return BusinessCategory.findOne({
    where:      { id, is_active: 1, status: 'approved' },
    attributes: ['id', 'parent_id'],
    transaction,
  });
}

// `slug` is unique, and two different names can slugify identically ("Café" and
// "Cafe"), so walk a numeric suffix until the slug is free.
async function uniqueSlug(base, transaction) {
  const root = base || 'industry';
  let candidate = root;
  for (let n = 2; await BusinessCategory.findOne({ where: { slug: candidate }, attributes: ['id'], transaction }); n += 1) {
    candidate = `${root.slice(0, 114)}-${n}`;
  }
  return candidate;
}

// The "Others" path: the owner couldn't find their sub-industry and typed one.
// It becomes a PENDING child of the industry they DID find, and the business
// links to it immediately — the row is simply invisible everywhere public until
// an admin approves it.
//
// Industry names are globally unique and case-insensitive (uq_business_category_name),
// so within this system a name IS an industry's identity. Rather than attempt an
// insert the DB would reject, converge on the existing row: an approved match makes
// the pick a normal industry outright, and a pending match joins the suggestion
// already in the queue instead of filing a duplicate.
async function suggestSubIndustry(parentId, rawName, userId, transaction) {
  const name = rawName.trim();

  const existing = await BusinessCategory.findOne({ where: { name }, transaction });
  if (existing) {
    if (existing.status === 'rejected') throw new ValidationError(`"${name}" is not available as an industry`);
    return existing.id;
  }

  try {
    const row = await BusinessCategory.create({
      uid:                  uuid(),
      parent_id:            parentId,
      name,
      slug:                 await uniqueSlug(slugify(name), transaction),
      status:               'pending',
      is_active:            0,           // keeps it out of every public catalogue read
      suggested_by_user_id: userId,
    }, { transaction });
    return row.id;
  } catch (err) {
    // Two owners suggesting the same name at once: the unique index rejects the
    // loser, who then joins the winner's suggestion.
    if (err.name !== 'SequelizeUniqueConstraintError') throw err;
    const row = await BusinessCategory.findOne({ where: { name }, transaction });
    if (!row) throw err;
    return row.id;
  }
}

// Turns the signup selection into a category_id:
//   industry              — the top-level pick (slug / uid / numeric id)
//   sub_industry          — the child pick, validated to belong to `industry`
//   custom_sub_industry   — free text from "Others"; files a pending suggestion
// `industry` alone is valid (not every industry has children). The legacy
// `category_id` is still accepted and passes through untouched when none of the
// three friendly params are supplied, so pre-rename clients keep working.
async function resolveIndustry(data, userId, transaction) {
  const { industry, sub_industry, custom_sub_industry, ...rest } = data;

  const hasIndustry = industry !== undefined && industry !== '';
  const hasSub      = sub_industry !== undefined && sub_industry !== '';
  const hasCustom   = typeof custom_sub_industry === 'string' && custom_sub_industry.trim() !== '';
  if (!hasIndustry && !hasSub && !hasCustom) return rest;

  if (hasSub && hasCustom) {
    throw new ValidationError('Send either sub_industry or custom_sub_industry, not both');
  }

  let parent = null;
  if (hasIndustry) {
    parent = await findPublishedIndustry(industry, transaction);
    if (!parent) throw new ValidationError('Unknown industry');
  }

  if (hasSub) {
    const sub = await findPublishedIndustry(sub_industry, transaction);
    if (!sub) throw new ValidationError('Unknown sub_industry');
    if (parent && sub.parent_id !== parent.id) {
      throw new ValidationError('sub_industry does not belong to the given industry');
    }
    return { ...rest, category_id: sub.id };
  }

  if (hasCustom) {
    // A suggestion has to hang off a real industry, otherwise it lands in the
    // moderation queue with no context for the admin reviewing it.
    if (!parent) throw new ValidationError('industry is required when suggesting a custom sub_industry');
    return { ...rest, category_id: await suggestSubIndustry(parent.id, custom_sub_industry, userId, transaction) };
  }

  return { ...rest, category_id: parent.id };
}

// The logo and cover are uploaded before this call (and, at signup, before the
// business itself exists), so all the write can do is verify the caller is
// pointing at their OWN upload for that slot — otherwise a key naming somebody
// else's file, or a premium admin asset, would be saved verbatim.
const IMAGE_SLOTS = [['logo_s3_key', 'business_logo'], ['cover_s3_key', 'business_cover']];

async function assertOwnedImages(fields, userId) {
  for (const [field, slot] of IMAGE_SLOTS) {
    if (fields[field] !== undefined) fields[field] = await userUpload.assertOwnedKey(fields[field], slot, userId);
  }
}

// ---- Brand Kit typography ----

// You may only style a business with a font you can actually see — a library font
// or your own upload — and a premium library font needs the plan behind it.
// Without this a crafted id could mount any font, including one behind the paywall.
async function assertFontsUsable(fields, userId) {
  for (const field of ['heading_font_id', 'body_font_id']) {
    if (fields[field] !== undefined) await fontService.assertUsable(fields[field], userId);
  }
}

// ---- Watermark ----

// Stamping your own logo on a design is a paid capability, so switching it ON is
// refused without the entitlement. Switching it OFF is always allowed — a user
// whose plan lapsed must still be able to turn off something they can no longer
// use, and refusing that would trap them.
const WATERMARK_FEATURE = 'custom_watermark';

async function assertWatermarkAllowed(fields, userId) {
  if (fields.watermark_enabled === undefined) return;
  const enabling = Number(fields.watermark_enabled) === 1;
  if (!enabling) return;
  if (!(await quota.hasFeature(userId, WATERMARK_FEATURE))) {
    throw new ForbiddenError('Adding your own watermark requires a paid plan');
  }
}

// The owner's business read carries `watermark_allowed` alongside the stored
// flag, so the settings screen can render the toggle correctly — disabled with an
// upsell rather than enabled-then-rejected. It also covers a lapsed plan, where
// the flag is still 1 but the capability is gone; the app must stamp only when
// BOTH are true.
async function withWatermarkState(biz, userId) {
  if (!biz) return biz;
  const plain = biz.toJSON();
  plain.watermark_allowed = await quota.hasFeature(userId, WATERMARK_FEATURE);
  plain.watermark_active  = plain.watermark_allowed && Number(plain.watermark_enabled) === 1;
  return plain;
}

// ---- Brand colours ----

// Canonicalise the palette before it is stored. The validate middleware only
// checks the body (it discards Joi's converted value), so normalisation has to
// happen here: hex is upper-cased so `#ff0000` and `#FF0000` are one colour
// rather than two, and a blank label is dropped instead of stored as ''.
// Order is preserved exactly as sent — it is the palette's meaning.
function normalizeBrandColors(list) {
  if (list === undefined) return undefined;
  if (list === null) return null;
  return list.map(({ hex, label }) => ({
    hex: hex.toUpperCase(),
    ...(label && String(label).trim() ? { label: String(label).trim() } : {}),
  }));
}

// "MANAGE" on the brand palette — a full replace.
async function setBrandColors(uid, userId, brandColors) {
  const biz = await ownedBusinessOrThrow(uid, userId);
  await businessRepo.update(biz.id, { brand_colors: normalizeBrandColors(brandColors) });
  return (await businessRepo.findByUid(uid)).brand_colors;
}

async function getBrandColors(uid, userId) {
  const biz = await ownedBusinessOrThrow(uid, userId);
  return biz.brand_colors || [];
}

// ---- Keywords ("My Keywords" — the owner's tag picks) ----

// Keywords are always existing tags: there is no custom-keyword path, so an
// unrecognised one is a client bug and gets a clean 400 naming it rather than
// being silently dropped from the set. Accepts a numeric id, a slug, or the
// display name (what the picker shows).
async function resolveKeywords(refs, transaction) {
  if (refs === undefined) return undefined;                       // not supplied -> leave the set alone
  const list = Array.isArray(refs) ? refs : String(refs).split(',');

  const ids     = [];
  const unknown = [];
  for (const raw of list) {
    const ref = String(raw).trim();
    if (!ref) continue;
    const where = /^\d+$/.test(ref) ? { id: Number(ref) } : { [Op.or]: [{ slug: ref }, { name: ref }] };
    const tag   = await Tag.findOne({ where, attributes: ['id'], transaction });
    if (tag) ids.push(tag.id);
    else unknown.push(ref);
  }

  if (unknown.length) {
    throw new ValidationError('Validation failed', unknown.map((k) => ({
      field: 'keywords', message: `"${k}" is not a known keyword`,
    })));
  }
  return [...new Set(ids)];
}

async function createBusiness(userId, data) {
  const user = await userRepo.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  // A PERSONAL account has no business by definition, and the type is frozen once
  // signup finishes — so this is a dead end rather than something they can resolve
  // by switching. An account that never answered step 2 is answered by this call:
  // creating a business IS the business path, so don't make the client PATCH first
  // and leave a window where the two disagree.
  if (user.account_type === 'personal') {
    throw new ConflictError('This is a personal account and cannot have a business');
  }

  const existing = await businessRepo.findAllByUser(userId);
  if (existing.length >= MAX_BUSINESSES_PER_USER) {
    throw new ConflictError('You already have a business. Only one business per account is supported.');
  }

  // Signup writes the profile, the industry pick (possibly filing a suggestion)
  // and the keywords together — a half-written profile is worse than a failed one.
  // The onboarding stamp rides along: this is the last step of the BUSINESS flow,
  // so a rolled-back create must not leave the account looking finished.
  const uid_ = await sequelize.transaction(async (t) => {
    const { keywords, ...fields } = data;
    await assertOwnedImages(fields, userId);
    await assertWatermarkAllowed(fields, userId);
    await assertFontsUsable(fields, userId);
    if (fields.brand_colors !== undefined) fields.brand_colors = normalizeBrandColors(fields.brand_colors);
    const payload  = await resolveIndustry(fields, userId, t);
    const tagIds   = await resolveKeywords(keywords, t);
    const biz      = await businessRepo.create({ ...payload, uid: uuid(), user_id: userId }, t);
    if (tagIds) await biz.setTags(tagIds, { transaction: t });

    await userRepo.update(userId, {
      account_type:            'business',
      onboarding_completed_at: user.onboarding_completed_at || new Date(),
    }, t);

    return biz.uid;
  });

  return withWatermarkState(await businessRepo.findByUid(uid_, { include: OWNER_INCLUDE }), userId);
}

async function getMyBusinesses(userId) {
  const rows = await businessRepo.findAllByUser(userId, { include: OWNER_INCLUDE });
  return Promise.all(rows.map((b) => withWatermarkState(b, userId)));
}

// Owner-checked lookup shared by the read/update/delete trio.
async function ownedBusinessOrThrow(uid, userId, options = {}) {
  const biz = await businessRepo.findByUid(uid, options);
  if (!biz) throw new NotFoundError('Business not found');
  if (biz.user_id !== userId) throw new ForbiddenError('Access denied');
  return biz;
}

async function getBusiness(uid, userId) {
  return withWatermarkState(await ownedBusinessOrThrow(uid, userId, { include: OWNER_INCLUDE }), userId);
}

async function updateBusiness(uid, userId, data) {
  const biz = await ownedBusinessOrThrow(uid, userId);

  await sequelize.transaction(async (t) => {
    const { keywords, ...fields } = data;
    await assertOwnedImages(fields, userId);
    await assertWatermarkAllowed(fields, userId);
    await assertFontsUsable(fields, userId);
    if (fields.brand_colors !== undefined) fields.brand_colors = normalizeBrandColors(fields.brand_colors);
    const payload = await resolveIndustry(fields, userId, t);
    const tagIds  = await resolveKeywords(keywords, t);
    if (Object.keys(payload).length) await businessRepo.update(biz.id, payload, t);
    if (tagIds) await biz.setTags(tagIds, { transaction: t });   // full replace
  });

  // Swapping or clearing an image orphans the old file: delete it and give the
  // storage back. After the commit — the record is the source of truth, and a
  // storage hiccup must not roll back a save the user already made.
  for (const [field, slot] of IMAGE_SLOTS) {
    if (data[field] !== undefined) await userUpload.releaseReplaced(biz[field], data[field], userId);
  }

  return withWatermarkState(await businessRepo.findByUid(uid, { include: OWNER_INCLUDE }), userId);
}

// "MANAGE" on the My Keywords card — a full replace of the owner's picks.
async function setKeywords(uid, userId, keywords) {
  const biz    = await ownedBusinessOrThrow(uid, userId);
  const tagIds = await resolveKeywords(keywords);
  await biz.setTags(tagIds);
  return biz.getTags({ attributes: ['id', 'name', 'slug'], joinTableAttributes: [] });
}

async function getKeywords(uid, userId) {
  const biz = await ownedBusinessOrThrow(uid, userId);
  return biz.getTags({ attributes: ['id', 'name', 'slug'], joinTableAttributes: [] });
}

async function deleteBusiness(uid, userId) {
  const biz = await ownedBusinessOrThrow(uid, userId);
  await businessRepo.update(biz.id, { is_active: 0 });

  // Everything hanging off the business goes with it — logo, cover, and the
  // images of its live products. Otherwise deleting a business would strand its
  // storage as permanently charged with no route left to reclaim it. Products
  // already soft-deleted released their own images at the time, so the
  // active-only list here is exactly the remainder.
  await userUpload.release(biz.logo_s3_key, userId);
  await userUpload.release(biz.cover_s3_key, userId);
  for (const product of await productRepo.findByBusiness(biz.id)) {
    await productService.releaseImagesOf(product.id, userId);
  }
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
  // Only PUBLISHED industries resolve here, so filtering by a pending suggestion
  // returns nothing — the businesses attached to it stay unlabelled until approval.
  const catRef     = pick(query.category, query.category_id);
  const resolvedCat = await findPublishedIndustry(catRef);
  const categoryId = catRef === undefined ? null : (resolvedCat ? resolvedCat.id : 0);
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

// ---- "Add to your Business" — business-scoped variant adoption ----
// The button reads "Use This Brand Series", but the grant is per-VARIANT: gating lives
// on the variant, so adopting one does not unlock its siblings in the same series.

// Lightweight template cards for the adopted collection (never the heavy `content`).
const ADOPTED_TEMPLATE_ATTRS = ['id', 'uid', 'name', 'thumbnail_s3_key', 'template_type', 'status'];

function loadVariantsWithTemplates(where) {
  return Variant.findAll({
    where,
    include: [
      { model: Template,         through: { attributes: [] }, attributes: ADOPTED_TEMPLATE_ATTRS, where: { status: 'active' }, required: false },
      { model: BusinessCategory, through: { attributes: [] }, attributes: ['id', 'uid', 'slug', 'name'] },
      { model: VariantBadge,     attributes: ['id', 'uid', 'slug', 'name', 'icon_s3_key'] },
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

// Adopt a variant into a business. Requires the owner's ACTIVE plan to entitle the
// variant (adoption itself never grants adoption). Idempotent: re-adopting is a no-op.
async function adoptVariant(userId, businessUid, variantUid) {
  const biz     = await ownedBusiness(businessUid, userId);
  const variant = await Variant.findOne({
    where: { uid: variantUid, is_active: 1 },
    include: [{ model: Plan, attributes: ['id'], through: { attributes: [] } }],
  });
  if (!variant) throw new NotFoundError('Variant not found');

  const allowedPlanIds = (variant.Plans || []).map((p) => p.id);
  if (!(await variantAccess.isPlanEntitled(allowedPlanIds, { userId }))) {
    throw new ForbiddenError('Your plan does not include this variant');
  }

  await BusinessVariant.findOrCreate({ where: { business_id: biz.id, variant_id: variant.id } });
  const [shaped] = await loadVariantsWithTemplates({ id: variant.id });
  return shaped;
}

async function listAdoptedVariants(userId, businessUid) {
  const biz   = await ownedBusiness(businessUid, userId);
  const links = await BusinessVariant.findAll({ where: { business_id: biz.id }, attributes: ['variant_id'] });
  if (!links.length) return [];
  return loadVariantsWithTemplates({ id: links.map((l) => l.variant_id) });
}

async function removeAdoptedVariant(userId, businessUid, variantUid) {
  const biz     = await ownedBusiness(businessUid, userId);
  const variant = await Variant.findOne({ where: { uid: variantUid } });
  if (!variant) throw new NotFoundError('Variant not found');
  await BusinessVariant.destroy({ where: { business_id: biz.id, variant_id: variant.id } });
}

module.exports = {
  createBusiness, getMyBusinesses, getBusiness, updateBusiness, deleteBusiness,
  getKeywords, setKeywords, getBrandColors, setBrandColors,
  listNearby, getPublicProfile, getPublicProducts,
  adoptVariant, listAdoptedVariants, removeAdoptedVariant,
  MAX_BUSINESSES_PER_USER,
};
