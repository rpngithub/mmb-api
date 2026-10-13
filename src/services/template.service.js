const { Op, literal } = require('sequelize');
const templateRepo  = require('../repositories/template.repository');
const familyRepo    = require('../repositories/templateFamily.repository');
const activityRepo  = require('../repositories/activityLog.repository');
const variantAccess = require('./variantAccess.service');
const picker        = require('./templateFamilyPicker');
const publish       = require('./templatePublish');
const favourites    = require('./favourite.service');
const {
  Template, TemplateFamily, TemplateCategory, BusinessCategory, TemplateSize, Tag, Language,
} = require('../models');
const { resolveRef, resolveRefList, pick } = require('../utils/catalogRef');
const { parseSearchQuery, escapeLike, containsPattern } = require('../utils/textSearch');
const { NotFoundError, ValidationError } = require('../errors');

// Public lists are lists of DESIGNS (template families): one card per design, showing
// the version picked for the viewer (see templateFamilyPicker). A card's `uid` is that
// VERSION's, so GET /templates/:uid opens it exactly as before.

const FAMILY = '`TemplateFamily`.`id`';

// Designs that belong to any variant are premium Brand Series content — they must
// never surface in the public catalog (browse or direct fetch), even via a category
// anchor. Locked variant designs ARE listed, but only on the variant detail
// endpoint, which shows them as upsell teasers with the design payload stripped.
const NOT_A_VARIANT_MEMBER = literal(
  `NOT EXISTS (SELECT 1 FROM \`variant_templates\` vt WHERE vt.family_id = ${FAMILY})`,
);

const DEFAULT_LIMIT = 30;
const MAX_LIMIT     = 100;
const TEMPLATE_TYPES = ['image', 'video', 'animated'];

// Premium designs are `is_locked` for guests and free users. That flag only tells
// the clients to ask for a subscription or the access pass at export/share — the
// content itself is served to everyone so the design can be edited first.
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

// Membership filter against a family M2M join table. EXISTS keeps pagination/ordering
// correct and avoids the duplicate rows a plain JOIN would produce. All ids are
// sanitized to positive integers above, so interpolation here is injection-safe.
const existsIn = (table, fkColumn, ids) =>
  literal(`EXISTS (SELECT 1 FROM \`${table}\` j WHERE j.family_id = ${FAMILY} ` +
          `AND j.\`${fkColumn}\` IN (${ids.map(Number).join(',')}))`);

// Correlated count against a table keyed by family — one query for the whole page
// instead of an include per relation (which would also duplicate rows).
const countIn = (table, alias, extra = '') =>
  [literal(`(SELECT COUNT(*) FROM \`${table}\` j WHERE j.family_id = ${FAMILY}${extra})`), alias];

// ---- Plain-text search (`q`) ----
// Every word of the query must match the design somewhere; different words may
// match different places ("diwali sale" finds a design named "Diwali Bonanza"
// tagged "sale"). Where a word may match:
//   the design   — name, admin search_keywords, template_type
//   its taxonomy — tag names, category (or its parent), industries (or their
//                  parents), special events; only active taxonomy counts
//   its versions — an ACTIVE version's language (whole word: code, name or native
//                  name, so "en" does not match every English design) or size
//                  (name / slug substring, platform whole word)
// Variant (Brand Series) designs never match: listTemplates already excludes them.
// Values are inlined through sequelize.escape and LIKE patterns have their
// wildcards escaped, so user input cannot alter the SQL or widen a match.
const FAMILY_NAME     = '`TemplateFamily`.`name`';
const FAMILY_KEYWORDS = '`TemplateFamily`.`search_keywords`';
const esc = (v) => TemplateFamily.sequelize.escape(v);

// The fields that DESCRIBE a design (vs. where it is filed); a hit here ranks higher.
const describesSql = (like) =>
  `(${FAMILY_NAME} LIKE ${like} OR ${FAMILY_KEYWORDS} LIKE ${like}` +
  ` OR EXISTS (SELECT 1 FROM \`template_tags\` j JOIN \`tags\` t ON t.id = j.tag_id` +
  ` WHERE j.family_id = ${FAMILY} AND t.name LIKE ${like}))`;

function wordMatchSql(word) {
  const like = esc(containsPattern(word));
  const exact = esc(word);
  return `(${describesSql(like)}` +
    ` OR \`TemplateFamily\`.\`template_type\` = ${exact}` +
    ` OR EXISTS (SELECT 1 FROM \`template_categories\` c LEFT JOIN \`template_categories\` pc ON pc.id = c.parent_id` +
    `   WHERE c.id = \`TemplateFamily\`.\`category_id\` AND c.is_active = 1 AND (c.name LIKE ${like} OR pc.name LIKE ${like}))` +
    ` OR EXISTS (SELECT 1 FROM \`template_business_categories\` j JOIN \`business_categories\` b ON b.id = j.business_category_id` +
    `   LEFT JOIN \`business_categories\` pb ON pb.id = b.parent_id` +
    `   WHERE j.family_id = ${FAMILY} AND b.is_active = 1 AND (b.name LIKE ${like} OR pb.name LIKE ${like}))` +
    ` OR EXISTS (SELECT 1 FROM \`special_event_templates\` j JOIN \`special_events\` e ON e.id = j.event_id` +
    `   WHERE j.family_id = ${FAMILY} AND e.is_active = 1 AND e.name LIKE ${like})` +
    ` OR EXISTS (SELECT 1 FROM \`templates\` v JOIN \`languages\` l ON l.id = v.language_id` +
    `   WHERE v.family_id = ${FAMILY} AND v.status = 'active' AND (l.code = ${exact} OR l.name = ${exact} OR l.native_name = ${exact}))` +
    ` OR EXISTS (SELECT 1 FROM \`templates\` v JOIN \`template_sizes\` s ON s.id = v.size_id` +
    `   WHERE v.family_id = ${FAMILY} AND v.status = 'active' AND (s.name LIKE ${like} OR s.slug LIKE ${like} OR s.platform = ${exact})))`;
}

// Relevance tier, lower first: the name starts with the whole query, then contains
// it, then every word is in the describing fields, then matched via taxonomy,
// language or size. trending_score orders within a tier.
function relevanceSql({ phrase, words }) {
  const all = words.map((w) => describesSql(esc(containsPattern(w)))).join(' AND ');
  return `CASE WHEN ${FAMILY_NAME} LIKE ${esc(`${escapeLike(phrase)}%`)} THEN 0` +
    ` WHEN ${FAMILY_NAME} LIKE ${esc(containsPattern(phrase))} THEN 1` +
    ` WHEN ${all} THEN 2 ELSE 3 END`;
}

// A search naming a language ("tamil diwali", "தமிழ்") is asking for designs IN it,
// so that language goes to the front of the viewer's rank: those versions become
// visible and are the ones the cards show. An explicit `language` or
// `all_languages` param is the client's own choice and is left alone.
async function rankSearchedLanguages(search, filters, languageIds) {
  if (!languageIds || filters.language !== undefined) return languageIds;
  const named = await Language.findAll({
    where: {
      is_active: 1,
      [Op.or]: [{ code: search.words }, { name: search.words }, { native_name: search.words }],
    },
    attributes: ['id'],
  });
  if (!named.length) return languageIds;
  const first = named.map((l) => l.id);
  return [...first, ...languageIds.filter((id) => !first.includes(id))];
}

async function listTemplates(filters = {}, viewer = null) {
  // Anchor / narrowing filters accept a friendly slug, a uid, or a legacy int id.
  // `category` ↔ legacy `category_id`; `industry` (the public name for a business
  // category) ↔ deprecated `business_category` ↔ legacy `business_category_id`;
  // `size` ↔ `size_id`, `tags` (comma list of any of the three).
  const categoryRef = pick(filters.category, filters.category_id);
  const industryRef = pick(filters.industry, pick(filters.business_category, filters.business_category_id));

  // Plain-text search; null when `q` is absent or too short to count.
  const search = parseSearchQuery(filters.q);

  // Public browse must be anchored: we never dump the full catalog. At least one
  // of template category / industry / a search must be SUPPLIED (a ref that fails
  // to resolve is still an anchor — it just yields an empty page, not a 400). A
  // search anchors on its own: it is the app-wide search box, and it is already a
  // narrow, paged slice. variant_id is intentionally NOT accepted here — a
  // variant's templates are premium and plan-gated, served only via the
  // entitlement-checked GET /variants/{uid}.
  if (categoryRef === undefined && industryRef === undefined && !search) {
    throw new ValidationError(
      'At least one of category, industry or q is required',
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
  if (filters.is_popular !== undefined) where.is_popular = toPosInt(filters.is_popular) ? 1 : 0;

  // Only designs the viewer can see: an active version in their languages (or a
  // text-free one) and, when a size is filtered, in that size.
  let languageIds = await picker.resolveLanguageRank(filters, viewer);
  if (search) languageIds = await rankSearchedLanguages(search, filters, languageIds);

  const membership = [NOT_A_VARIANT_MEMBER, picker.versionMatchClause(FAMILY, { languageIds, sizeId })];
  if (businessCategoryId !== undefined) membership.push(existsIn('template_business_categories', 'business_category_id', [businessCategoryId]));
  if (tagIds.length)                    membership.push(existsIn('template_tags',                'tag_id',               tagIds));
  if (search) for (const word of search.words) membership.push(literal(wordMatchSql(word)));
  where[Op.and] = membership;

  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const order = [['trending_score', 'DESC'], ['id', 'DESC']];
  if (search) order.unshift([literal(relevanceSql(search)), 'ASC']);

  const families = await familyRepo.findMany(where, {
    order,
    limit,
    offset,
  });

  const paid = isPaidViewer(viewer);
  const cards = await picker.familiesToCards(families, { languageIds, sizeId }, (f) => Boolean(f.is_premium) && !paid);
  return favourites.markFavourited(cards, viewer, 'template');
}

/**
 * Open one version of a design. The response keeps the template shape clients know
 * (the version's fields plus the design's shared ones) and adds `family` and
 * `versions` — every active language × size of the design — for the editor's
 * switcher.
 *
 * @param {object} [opts.countView=true]  false for a switch between versions of a
 *   design the viewer already has open (`?switch=1`): one open = one view.
 */
async function getTemplate(uid, viewer = null, { countView = true } = {}) {
  // Public endpoint: only active versions of active designs are visible — drafts
  // stay hidden even when the uid is known directly (mirrors the list filter).
  const tpl = await templateRepo.findOne({ uid, status: 'active' }, {
    include: [
      { model: TemplateFamily, as: 'family' },
      { model: Language,       attributes: picker.LANGUAGE_ATTRS },
      { model: TemplateSize,   attributes: picker.SIZE_ATTRS },
    ],
  });
  if (!tpl || tpl.family?.status !== 'active') throw new NotFoundError('Template not found');
  const family = tpl.family;

  // A variant design is premium, plan-gated content and is not part of the public
  // catalog: hide it entirely (404) unless the viewer is entitled or has adopted it.
  // When they may access it, the variant gate supersedes is_premium → full content.
  const access = await variantAccess.canAccessFamily(family.id, viewer);
  if (access.variantGated && !access.allowed) throw new NotFoundError('Template not found');

  if (countView) {
    // Views count for the DESIGN, so a popular design is not split across its
    // languages. The activity row names the version; the trending job rolls it up.
    await familyRepo.incrementCounter(family.id, 'views_count');
    if (viewer?.userId) {
      await activityRepo.create({
        actor_type:  'user',
        actor_id:    viewer.userId,
        entity_type: 'template',
        entity_id:   tpl.id,
        action:      'template_view',
      });
    }
  }

  const [picked] = [...(await picker.pickVersions([family.id], { hide: false })).values()];
  const version  = tpl.toJSON();
  delete version.family;

  const locked = !access.variantGated && Boolean(family.is_premium) && !isPaidViewer(viewer);
  const data = picker.toCard(family.toJSON(), {
    version,
    available_languages: picked ? picked.available_languages : [],
    available_sizes:     picked ? picked.available_sizes : [],
  }, { locked });

  data.created_by = version.created_by;
  data.family = { id: family.id, uid: family.uid, name: family.name };
  data.versions = (picked ? picked.versions : []).map((v) => ({
    id: v.id, uid: v.uid, language_id: v.language_id, size_id: v.size_id,
    thumbnail_s3_key: v.thumbnail_s3_key, Language: v.Language || null, TemplateSize: v.TemplateSize || null,
  }));
  return favourites.markFavourited(data, viewer, 'template');
}

/**
 * Open a design by its family uid (share links, deep links): the version is picked
 * for the viewer exactly as a feed card would be. Unlike the feed, a link is never
 * hidden for language — a design with no version in the viewer's languages opens
 * in its best one (English first).
 */
async function getFamily(uid, viewer = null) {
  const family = await familyRepo.findOne({ uid, status: 'active' }, { attributes: ['id'] });
  if (!family) throw new NotFoundError('Template not found');

  const languageIds = await picker.resolveLanguageRank({}, viewer);
  const defaultSize = await picker.defaultSizeId();
  const picks = await picker.pickVersions([family.id], { languageIds, defaultSize, hide: false });
  const chosen = picks.get(family.id);
  if (!chosen) throw new NotFoundError('Template not found');
  return getTemplate(chosen.version.uid, viewer);
}

// ---- Admin ----

// Admin browse of DESIGNS: no mandatory anchor, every status (filterable). Each row
// carries what the family list needs: version counts, the languages and sizes it
// covers, a thumbnail, and readiness (what still blocks publishing).
async function listFamiliesForAdmin(filters = {}) {
  const where = {};
  if (['active', 'inactive', 'draft'].includes(filters.status)) where.status = filters.status;
  if (TEMPLATE_TYPES.includes(filters.template_type)) where.template_type = filters.template_type;
  if (filters.is_premium !== undefined) where.is_premium = toPosInt(filters.is_premium) ? 1 : 0;
  if (filters.is_popular !== undefined) where.is_popular = toPosInt(filters.is_popular) ? 1 : 0;

  const categoryId = toPosInt(filters.category_id);
  if (categoryId) where.category_id = categoryId;
  if (filters.search) where.name = { [Op.like]: containsPattern(filters.search) };

  const membership = [];
  // `industry_id` is the public name; `business_category_id` the deprecated alias.
  const businessCategoryId = toPosInt(filters.industry_id ?? filters.business_category_id);
  // `variant_id` is the current name; `theme_id` the deprecated alias.
  const variantId          = toPosInt(filters.variant_id ?? filters.theme_id);
  const tagIds             = toPosIntList(filters.tags);
  if (businessCategoryId) membership.push(existsIn('template_business_categories', 'business_category_id', [businessCategoryId]));
  if (variantId)          membership.push(existsIn('variant_templates',            'variant_id',           [variantId]));
  if (tagIds.length)      membership.push(existsIn('template_tags',                'tag_id',               tagIds));

  // Leftovers from the one-family-per-template migration, for merging by eye.
  if (toPosInt(filters.single_version)) {
    membership.push(literal(`(SELECT COUNT(*) FROM \`templates\` v WHERE v.family_id = ${FAMILY}) = 1`));
  }
  // Families without any version in the default size (after an admin changes it).
  if (toPosInt(filters.missing_default_size)) {
    const sizeId = await picker.defaultSizeId();
    if (sizeId) membership.push(literal(`NOT EXISTS (SELECT 1 FROM \`templates\` v WHERE v.family_id = ${FAMILY} AND v.size_id = ${Number(sizeId)})`));
  }
  if (membership.length) where[Op.and] = membership;

  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const result = await familyRepo.findAndCountAll(where, {
    attributes: {
      include: [
        countIn('templates',                    'version_count'),
        countIn('templates',                    'active_version_count', " AND j.status = 'active'"),
        countIn('template_tags',                'tag_count'),
        countIn('template_business_categories', 'industry_count'),
      ],
    },
    order: [['id', 'DESC']],
    limit,
    offset,
  });

  const ids = result.rows.map((r) => r.id);
  const versions = ids.length ? await Template.findAll({
    where:      { family_id: { [Op.in]: ids } },
    attributes: ['id', 'uid', 'family_id', 'language_id', 'size_id', 'thumbnail_s3_key', 'status'],
    include:    [
      { model: Language,     attributes: picker.LANGUAGE_ATTRS },
      { model: TemplateSize, attributes: picker.SIZE_ATTRS },
    ],
    order: [['id', 'ASC']],
  }) : [];
  const byFamily = new Map(ids.map((id) => [id, []]));
  for (const v of versions) byFamily.get(v.family_id).push(v.toJSON());

  const defaultSize = await picker.defaultSizeId();
  const rows = await Promise.all(result.rows.map(async (row) => {
    const data = row.toJSON();
    const own  = byFamily.get(row.id) || [];
    const thumb = own.find((v) => v.size_id === defaultSize && (v.language_id === null || v.Language?.code === 'en'))
      || own.find((v) => v.thumbnail_s3_key) || null;
    data.languages        = [...new Map(own.filter((v) => v.Language).map((v) => [v.Language.id, v.Language])).values()];
    data.sizes            = [...new Map(own.filter((v) => v.TemplateSize).map((v) => [v.TemplateSize.id, v.TemplateSize])).values()];
    data.text_free        = own.length > 0 && own.every((v) => v.language_id === null);
    data.thumbnail_s3_key = thumb ? thumb.thumbnail_s3_key : null;
    data.readiness        = await publish.missingForFamily(row);
    return data;
  }));

  return { count: result.count, rows };
}

// Admin browse of VERSIONS (of one family, or across families): every status,
// `content` excluded; completeness flags mirror the version publish gate.
async function listTemplatesForAdmin(filters = {}) {
  const where = {};
  if (['active', 'inactive', 'draft'].includes(filters.status)) where.status = filters.status;

  const familyId = toPosInt(filters.family_id);
  if (familyId) where.family_id = familyId;
  if (filters.family_uid) {
    const family = await TemplateFamily.findOne({ where: { uid: filters.family_uid }, attributes: ['id'] });
    where.family_id = family ? family.id : 0;
  }
  if (filters.language_id === 'null') where.language_id = null;
  else if (toPosInt(filters.language_id)) where.language_id = toPosInt(filters.language_id);
  const sizeId = toPosInt(filters.size_id);
  if (sizeId) where.size_id = sizeId;
  if (filters.search) where.name = { [Op.like]: containsPattern(filters.search) };

  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  return templateRepo.findAndCountAll(where, {
    attributes: {
      exclude: ['content'],
      include: [
        [literal("(`Template`.`content` IS NOT NULL AND `Template`.`content` <> '')"), 'has_content'],
        [literal("(`Template`.`thumbnail_s3_key` IS NOT NULL AND `Template`.`thumbnail_s3_key` <> '')"), 'has_thumbnail'],
      ],
    },
    include: [
      { model: TemplateFamily, as: 'family', attributes: ['id', 'uid', 'name', 'status'] },
      { model: Language,       attributes: picker.LANGUAGE_ATTRS },
      { model: TemplateSize,   attributes: picker.SIZE_ATTRS },
    ],
    order: [['id', 'DESC']],
    limit,
    offset,
  });
}

module.exports = { listTemplates, getTemplate, getFamily, listFamiliesForAdmin, listTemplatesForAdmin };
