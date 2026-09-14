const { Op } = require('sequelize');
const { sequelize, PageSection, PageSectionItem, BusinessCategory } = require('../models');
const { ConflictError, NotFoundError } = require('../errors');

const DEFAULT_PAGE_KEY = 'industry';

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
// The whole point of a default row is that ONE piece of copy is correct on every
// industry page. `{{industry}}` is what makes that possible: "engaging videos for
// your {{industry_lower}} brand" reads correctly on all hundred of them and can
// never drift out of sync with the page it is on, which is exactly how the live
// site ended up offering fitness content under a Travel heading.
//
// Unknown or unresolvable tokens are removed rather than printed — a visitor
// should never see `{{industry}}` on a live page — and the run of spaces that
// leaves behind is collapsed, so "your {{industry_lower}} brand" degrades to
// "your brand" and not "your  brand".
const TOKEN_RE = /\{\{\s*([a-z_]+)\s*\}\}/gi;

function render(text, vars) {
  if (typeof text !== 'string' || !text.includes('{{')) return text;
  return text
    .replace(TOKEN_RE, (_match, key) => vars[key.toLowerCase()] ?? '')
    .replace(/[^\S\n]{2,}/g, ' ')   // collapse runs of spaces/tabs, keep line breaks
    .trim();
}

// The variables available to a section's copy. Deliberately small: these are the
// facts about the page that the editor cannot know at authoring time. Anything
// else belongs in the text itself.
function tokenVars(industry) {
  if (!industry) return {};
  return {
    industry:       industry.name,
    industry_lower: String(industry.name).toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// Public resolution
// ---------------------------------------------------------------------------
/**
 * The merge rule, as a pure function over the fetched rows — this is the subtle
 * part of the feature and the part worth testing on its own.
 *
 * Choose first, filter second. That ordering is the whole trick: an override row
 * claims its section_key slot even when it is inactive, so filtering afterwards
 * removes the default along with it. Reversing the two steps would let a
 * deliberately hidden block reappear as the shared default, which is the opposite
 * of what the editor asked for.
 *
 * @param {Array} rows  sections for one page across both scopes (default + one industry)
 * @returns {Array} the visible sections, in page order
 */
function chooseSections(rows) {
  const chosen = new Map();
  for (const row of rows) {
    const current = chosen.get(row.section_key);
    if (!current || (row.business_category_id != null && current.business_category_id == null)) {
      chosen.set(row.section_key, row);
    }
  }
  return [...chosen.values()]
    .filter((row) => row.is_active)
    .sort((a, b) => a.display_order - b.display_order || a.id - b.id);
}

/**
 * The sections a website page should render, already merged and rendered.
 *
 * Merge rule (per `section_key`, not all-or-nothing):
 *   - an industry's own row wins over the default row
 *   - an INACTIVE override hides the inherited default — that is the only way to
 *     suppress a default for one industry, which is why overrides are read
 *     regardless of their active flag and filtered afterwards
 *   - an inactive default with no override simply doesn't appear
 *
 * @param {object}  opts
 * @param {string} [opts.pageKey]   which page (default 'industry')
 * @param {object} [opts.industry]  BusinessCategory instance/row; omit for a
 *                                  page that isn't industry-scoped
 */
async function resolveSections({ pageKey = DEFAULT_PAGE_KEY, industry = null } = {}) {
  const scope = industry
    ? { [Op.or]: [{ business_category_id: null }, { business_category_id: industry.id }] }
    : { business_category_id: null };

  const rows = await PageSection.findAll({
    where: { page_key: pageKey, ...scope },
    order: [['display_order', 'ASC'], ['id', 'ASC']],
  });

  const live = chooseSections(rows);

  const items = live.length
    ? await PageSectionItem.findAll({
      where: { section_id: { [Op.in]: live.map((r) => r.id) }, is_active: 1 },
      order: [['display_order', 'ASC'], ['id', 'ASC']],
    })
    : [];

  const bySection = new Map();
  for (const item of items) {
    if (!bySection.has(item.section_id)) bySection.set(item.section_id, []);
    bySection.get(item.section_id).push(item);
  }

  const vars = tokenVars(industry);
  return live.map((row) => ({
    // Integer id alongside uid, as every other catalogue payload carries: the admin
    // panel creates items against `section_id` and needs it from this same read.
    id:            row.id,
    uid:           row.uid,
    section_key:   row.section_key,
    eyebrow:       render(row.eyebrow, vars),
    heading:       render(row.heading, vars),
    subheading:    render(row.subheading, vars),
    image_s3_key:  row.image_s3_key,
    display_order: row.display_order,
    // Whether this industry is showing the shared default or its own copy. The
    // admin panel uses it to label an inherited block; the website can ignore it.
    inherited:     row.business_category_id == null,
    items: (bySection.get(row.id) || []).map((item) => ({
      id:            item.id,
      uid:           item.uid,
      title:         render(item.title, vars),
      body:          render(item.body, vars),
      icon_s3_key:   item.icon_s3_key,
      link_url:      item.link_url,
      display_order: item.display_order,
    })),
  }));
}

// Convenience wrapper for the industry landing page: resolve by an industry row
// that the caller has already loaded, so no second lookup happens.
const resolveIndustrySections = (industry) => resolveSections({ pageKey: DEFAULT_PAGE_KEY, industry });

// ---------------------------------------------------------------------------
// Admin write guards
// ---------------------------------------------------------------------------
/**
 * adminCrud `beforeWrite` for page sections.
 *
 * Enforces the composite scope uniqueness that the DB index cannot: MySQL allows
 * unlimited NULLs in a UNIQUE index, so `uq_page_sections_scope` does not stop a
 * second DEFAULT row for the same (page_key, section_key) — the duplicate that
 * would actually be ambiguous, since the resolver would then pick one arbitrarily.
 *
 * Also verifies the industry exists, so a bad id yields a 404 rather than a raw
 * foreign-key 500.
 */
async function assertSectionScope(payload, row) {
  const pageKey    = payload.page_key    ?? row?.page_key ?? DEFAULT_PAGE_KEY;
  const sectionKey = payload.section_key ?? row?.section_key;
  const industryId = payload.business_category_id !== undefined
    ? payload.business_category_id
    : (row ? row.business_category_id : null);

  if (industryId != null && !(await BusinessCategory.findByPk(industryId))) {
    throw new NotFoundError('industry not found');
  }
  if (!sectionKey) return;   // create is rejected by the Joi schema; update may omit it

  const where = { page_key: pageKey, section_key: sectionKey, business_category_id: industryId ?? null };
  if (row) where.id = { [Op.ne]: row.id };
  if (await PageSection.findOne({ where })) {
    throw new ConflictError(
      industryId == null
        ? `A default "${sectionKey}" section already exists for the ${pageKey} page`
        : `This industry already has a "${sectionKey}" section`,
    );
  }
}

// adminCrud `beforeWrite` for items: a section must exist to hang an item on.
async function assertItemSection(payload, row) {
  const sectionId = payload.section_id ?? row?.section_id;
  if (sectionId == null) return;
  if (!(await PageSection.findByPk(sectionId))) throw new NotFoundError('page section not found');
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------
/**
 * Copy the shared default sections (and their items) into one industry so an
 * editor can start from the real copy and edit it, rather than face an empty
 * form. This is the workflow that makes per-industry copy affordable at all.
 *
 * Refuses rather than overwrites: if the industry already has any of the sections
 * being cloned, the whole call fails with a 409 naming them. Silently replacing
 * hand-written copy with the defaults is not a recoverable mistake.
 *
 * @param {object}   opts
 * @param {string}  [opts.pageKey]
 * @param {number}   opts.industryId
 * @param {string[]}[opts.sectionKeys]  clone only these; omit for all defaults
 */
async function cloneDefaultsToIndustry({ pageKey = DEFAULT_PAGE_KEY, industryId, sectionKeys = null }) {
  const industry = await BusinessCategory.findByPk(industryId);
  if (!industry) throw new NotFoundError('industry not found');

  const defaults = await PageSection.findAll({
    where: {
      page_key: pageKey,
      business_category_id: null,
      ...(sectionKeys?.length ? { section_key: { [Op.in]: sectionKeys } } : {}),
    },
    order: [['display_order', 'ASC'], ['id', 'ASC']],
  });
  if (!defaults.length) throw new NotFoundError(`no default sections found for the ${pageKey} page`);

  if (sectionKeys?.length) {
    const found   = new Set(defaults.map((d) => d.section_key));
    const missing = sectionKeys.filter((k) => !found.has(k));
    if (missing.length) throw new NotFoundError(`no default section for: ${missing.join(', ')}`);
  }

  const existing = await PageSection.findAll({
    where: {
      page_key: pageKey,
      business_category_id: industryId,
      section_key: { [Op.in]: defaults.map((d) => d.section_key) },
    },
    attributes: ['section_key'],
  });
  if (existing.length) {
    throw new ConflictError(`This industry already has its own: ${existing.map((e) => e.section_key).join(', ')}`);
  }

  const sourceItems = await PageSectionItem.findAll({
    where: { section_id: { [Op.in]: defaults.map((d) => d.id) } },
    order: [['display_order', 'ASC'], ['id', 'ASC']],
  });
  const itemsBySection = new Map();
  for (const item of sourceItems) {
    if (!itemsBySection.has(item.section_id)) itemsBySection.set(item.section_id, []);
    itemsBySection.get(item.section_id).push(item);
  }

  // All-or-nothing: a half-cloned page is worse than an un-cloned one, because
  // the missing halves silently fall back to defaults and look intentional.
  return sequelize.transaction(async (t) => {
    const created = [];
    for (const source of defaults) {
      const section = await PageSection.create({
        page_key:             pageKey,
        business_category_id: industryId,
        section_key:          source.section_key,
        eyebrow:              source.eyebrow,
        heading:              source.heading,
        subheading:           source.subheading,
        image_s3_key:         source.image_s3_key,
        display_order:        source.display_order,
        is_active:            source.is_active,
      }, { transaction: t });

      for (const item of itemsBySection.get(source.id) || []) {
        await PageSectionItem.create({
          section_id:    section.id,
          title:         item.title,
          body:          item.body,
          icon_s3_key:   item.icon_s3_key,
          link_url:      item.link_url,
          display_order: item.display_order,
          is_active:     item.is_active,
        }, { transaction: t });
      }
      created.push(section);
    }
    return created;
  });
}

module.exports = {
  DEFAULT_PAGE_KEY,
  render, tokenVars, chooseSections,
  resolveSections, resolveIndustrySections,
  assertSectionScope, assertItemSection,
  cloneDefaultsToIndustry,
};
