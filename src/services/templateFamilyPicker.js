const { Op, literal } = require('sequelize');
const { Template, TemplateSize, Language } = require('../models');
const userService   = require('./user.service');
const configService = require('./config.service');
const { resolveRefList } = require('../utils/catalogRef');

// Which version of a design (template family) a viewer sees, and whether they see
// the design at all. Shared by every public list of designs — the browse feed,
// special events and variant pages — so the rules cannot drift between them:
//
//   visible  a family is shown only if it has an ACTIVE version in one of the
//            viewer's languages, or a text-free one (language_id NULL, shown to
//            everyone) — and, when a size is filtered, in that size. A family
//            with none (an English + Hindi design, for a Tamil-only user) is hidden.
//   picked   the card shows the version in the viewer's highest-ranked language,
//            then the default size (app_settings.default_template_size), then
//            the lowest size id. Language beats size: a Tamil 1:1 version wins
//            over an English 4:5 one for a Tamil-first viewer.

const DEFAULT_SIZE_KEY = 'default_template_size';
const ENGLISH = 'en';

const LANGUAGE_ATTRS = ['id', 'code', 'name', 'native_name'];
const SIZE_ATTRS     = ['id', 'uid', 'slug', 'name', 'width', 'height', 'platform'];

// Version rows for cards never carry the heavy design JSON unless asked.
const VERSION_ATTRS = ['id', 'uid', 'family_id', 'language_id', 'size_id', 'name', 'thumbnail_s3_key', 'status', 'created_at', 'updated_at'];

// The viewer's languages in rank order, or null for "no narrowing".
//
// Precedence, most explicit first:
//   ?all_languages=1  — an explicit opt-out, for SEO/landing pages that must show
//                       the whole catalogue regardless of who is looking
//   ?language=ta,en   — browsing specific languages; the order given is the rank
//   the viewer's saved Preferred Languages, in the order they ranked them
//   English (the default for anyone who has never chosen, signed in or not)
//
// A supplied-but-unresolved `language` narrows to nothing (text-free designs
// still show) rather than silently widening to everything — the same rule the
// other catalogue filters follow.
async function resolveLanguageRank(filters = {}, viewer = null) {
  if (filters.all_languages !== undefined) return null;

  if (filters.language !== undefined && filters.language !== '') {
    return resolveRefList(Language, filters.language, { hasUid: false, field: 'code' });
  }

  const { languages } = await userService.effectiveLanguages(viewer?.userId ?? null);
  return languages.map((l) => l.id);
}

// The admin-chosen default size, as an id (null when unset or unknown).
async function defaultSizeId() {
  const slug = await configService.getSetting(DEFAULT_SIZE_KEY, '');
  if (!slug) return null;
  const size = await TemplateSize.findOne({ where: { slug: String(slug) }, attributes: ['id'] });
  return size ? size.id : null;
}

// SQL: "this family has an active version the viewer may see". `familyRef` is the
// quoted column holding the family id in the outer query. Every id is a sanitized
// positive integer, so interpolation is injection-safe.
function versionMatchSql(familyRef, { languageIds = null, sizeId } = {}) {
  const parts = [`v.family_id = ${familyRef}`, "v.status = 'active'"];
  if (languageIds) {
    parts.push(languageIds.length
      ? `(v.language_id IS NULL OR v.language_id IN (${languageIds.map(Number).join(',')}))`
      : 'v.language_id IS NULL');
  }
  if (sizeId !== undefined && sizeId !== null) parts.push(`v.size_id = ${Number(sizeId) || 0}`);
  return `EXISTS (SELECT 1 FROM \`templates\` v WHERE ${parts.join(' AND ')})`;
}

const versionMatchClause = (familyRef, opts) => literal(versionMatchSql(familyRef, opts));

function matchesViewer(version, { languageIds, sizeId }) {
  if (languageIds && version.language_id !== null && !languageIds.includes(version.language_id)) return false;
  if (sizeId !== undefined && sizeId !== null && version.size_id !== sizeId) return false;
  return true;
}

// Lower is better: language rank, then default size, then size id, then age.
function rankKey(version, { languageIds, defaultSize }) {
  let lang;
  if (version.language_id === null) lang = 0;
  else if (languageIds) lang = languageIds.indexOf(version.language_id);
  else lang = version.Language?.code === ENGLISH ? 0 : 1;
  const size = version.size_id === null ? 2 : (version.size_id === defaultSize ? 0 : 1);
  return [lang, size, version.size_id ?? Number.MAX_SAFE_INTEGER, version.id];
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const uniqueBy = (items, key) => {
  const seen = new Map();
  for (const item of items) if (item && !seen.has(item[key])) seen.set(item[key], item);
  return [...seen.values()];
};

/**
 * Pick the version each family shows for this viewer.
 *
 * @param {number[]} familyIds
 * @param {object}   opts  { languageIds, sizeId, defaultSize, withContent, hide }
 *   hide=false keeps a family even when nothing matches the viewer, falling back
 *   to its best version by the same ranking — used for a direct link to a design.
 * @returns {Promise<Map<number, {version, versions, available_languages, available_sizes}>>}
 */
async function pickVersions(familyIds, { languageIds = null, sizeId, defaultSize = null, withContent = false, hide = true } = {}) {
  const picks = new Map();
  if (!familyIds.length) return picks;

  const rows = await Template.findAll({
    where:      { family_id: { [Op.in]: familyIds }, status: 'active' },
    attributes: withContent ? [...VERSION_ATTRS, 'content'] : VERSION_ATTRS,
    include:    [
      { model: Language,     attributes: LANGUAGE_ATTRS },
      { model: TemplateSize, attributes: SIZE_ATTRS },
    ],
  });

  const byFamily = new Map();
  for (const row of rows) {
    const v = row.toJSON();
    if (!byFamily.has(v.family_id)) byFamily.set(v.family_id, []);
    byFamily.get(v.family_id).push(v);
  }

  for (const [familyId, versions] of byFamily) {
    const eligible = versions.filter((v) => matchesViewer(v, { languageIds, sizeId }));
    const pool = eligible.length ? eligible : (hide ? [] : versions);
    if (!pool.length) continue;

    const ranking = { languageIds, defaultSize };
    const [best] = pool.sort((a, b) => compareKeys(rankKey(a, ranking), rankKey(b, ranking)));
    picks.set(familyId, {
      version:             best,
      versions,
      available_languages: uniqueBy(versions.map((v) => v.Language), 'id'),
      available_sizes:     uniqueBy(versions.map((v) => v.TemplateSize), 'id'),
    });
  }
  return picks;
}

/**
 * The card for one family. Keeps the shape a template card always had — `id`/`uid`
 * are the PICKED VERSION's, so opening the card with GET /templates/:uid works as
 * before — and adds the family and what the design is available in.
 */
function toCard(family, pick, { locked }) {
  const v = pick.version;
  const card = {
    id:                  v.id,
    uid:                 v.uid,
    family_id:           family.id,
    family_uid:          family.uid,
    name:                family.name,
    category_id:         family.category_id,
    language_id:         v.language_id,
    size_id:             v.size_id,
    thumbnail_s3_key:    v.thumbnail_s3_key,
    template_type:       family.template_type,
    is_premium:          family.is_premium,
    is_popular:          family.is_popular,
    trending_score:      family.trending_score,
    views_count:         family.views_count,
    downloads_count:     family.downloads_count,
    likes_count:         family.likes_count,
    status:              v.status,
    created_at:          family.created_at,
    updated_at:          v.updated_at,
    Language:            v.Language || null,
    TemplateSize:        v.TemplateSize || null,
    available_languages: pick.available_languages,
    available_sizes:     pick.available_sizes,
    is_locked:           Boolean(locked),
  };
  // `is_locked` is a badge, not a gate: a premium design's content is served to
  // everyone so the editor can open it, and the clients ask for a subscription or
  // the access pass at export/share. Withholding happens upstream by not loading
  // content at all (withContent) — which is how a locked VARIANT stays stripped.
  if (v.content !== undefined) card.content = v.content;
  return card;
}

/**
 * Turn a list of family rows (plain or model instances, already filtered/ordered by
 * the caller) into viewer cards, keeping the caller's order and dropping families
 * the viewer may not see.
 *
 * @param {Array}    families
 * @param {object}   viewerOpts  { languageIds, sizeId, withContent, hide } — see pickVersions
 * @param {Function} isLocked    (family) => boolean
 */
async function familiesToCards(families, { languageIds = null, sizeId, withContent = false, hide = true } = {}, isLocked = () => false) {
  const plain = families.map((f) => (typeof f.toJSON === 'function' ? f.toJSON() : f));
  const defaultSize = await defaultSizeId();
  const picks = await pickVersions(plain.map((f) => f.id), { languageIds, sizeId, defaultSize, withContent, hide });
  return plain
    .filter((f) => picks.has(f.id))
    .map((f) => toCard(f, picks.get(f.id), { locked: isLocked(f) }));
}

module.exports = {
  resolveLanguageRank, defaultSizeId, versionMatchSql, versionMatchClause,
  pickVersions, toCard, familiesToCards,
  LANGUAGE_ATTRS, SIZE_ATTRS, DEFAULT_SIZE_KEY,
};
