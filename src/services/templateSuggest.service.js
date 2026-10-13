const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const picker = require('./templateFamilyPicker');
const { escapeLike, MAX_QUERY } = require('../utils/textSearch');
const { ValidationError } = require('../errors');

// Autocomplete for the template search box (GET /templates/suggestions?q=).
//
// Returns short, mixed suggestions — special events, categories, industries, tags
// and design names — as { type, label, query }. A tap sends `query` to
// GET /templates?q=, so every suggestion is built to come back with results:
//
//   * a design is suggested only if search would show it to this viewer — active,
//     not a Brand Series design, with a version in the viewer's languages (the same
//     `language` / `all_languages` / Preferred Languages rule as browse);
//   * a category, industry, tag or event only if at least one such design sits under
//     it (a parent category or industry counts its active children's designs, just
//     as search matches a parent's name), and only while it is itself active.
//
// Matching is on the START of the label or of any word in it ("diw" → "Happy
// Diwali"), case-insensitively. Ordering: whole-label prefix before word prefix, then
// type (events, categories, industries, tags, designs — broad intents before single
// designs), then popularity (designs in it, or trending_score for a design).
//
// A design is also suggested when the term starts one of its admin search_keywords
// ("deepav" → "Happy Diwali Wishes"). The suggestion is still the design's NAME —
// keywords are hidden synonyms and never shown — and it ranks as a word prefix, so
// it sits below designs whose name starts with the term. Search matches keywords
// too, so tapping it finds that design. Labels
// are de-duplicated case-insensitively, so a "Diwali" event and a "Diwali" tag are one
// suggestion — they would run the same search anyway.

const DEFAULT_LIMIT = 8;
const MAX_LIMIT     = 20;
const TAXONOMY_CAP  = 3;   // per type, so one type cannot fill the list
const TYPE_ORDER    = ['event', 'category', 'industry', 'tag', 'design'];

// A label longer than search accepts (design names run to 200) is cut at a word
// boundary: its first words still find it, and it ranks as a name prefix.
const toQuery = (label) => {
  if (label.length <= MAX_QUERY) return label;
  const cut = label.slice(0, MAX_QUERY);
  return cut.replace(/\s+\S*$/, '') || cut;
};

async function suggest(filters = {}, viewer = null) {
  const raw = filters.q === undefined || filters.q === null ? '' : String(Array.isArray(filters.q) ? filters.q[0] : filters.q);
  const term = raw.trim().replace(/\s+/g, ' ');
  if (!term) return [];
  if (term.length > MAX_QUERY) throw new ValidationError(`q must be at most ${MAX_QUERY} characters`);

  const limit = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const languageIds = await picker.resolveLanguageRank(filters, viewer);

  // "This family is a live design the viewer would see in search." Ids inside
  // versionMatchSql are sanitized integers; the user's text only travels as a
  // bound replacement.
  const live = (f) => `${f}.status = 'active'` +
    ` AND NOT EXISTS (SELECT 1 FROM \`variant_templates\` vt WHERE vt.family_id = ${f}.id)` +
    ` AND ${picker.versionMatchSql(`${f}.id`, { languageIds })}`;
  const matches = (col) => `(${col} LIKE :prefix OR ${col} LIKE :wordPrefix)`;
  const tier    = (col) => `CASE WHEN ${col} LIKE :prefix THEN 0 ELSE 1 END`;

  const replacements = {
    prefix:     `${escapeLike(term)}%`,
    wordPrefix: `% ${escapeLike(term)}%`,
    // search_keywords is stored comma-joined, so a later keyword starts after a comma.
    keywordPrefix: `%,${escapeLike(term)}%`,
    cap:       TAXONOMY_CAP,
    designCap:  limit,
  };
  const run = (sql) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  const [events, categories, industries, tags, designs] = await Promise.all([
    run(`SELECT e.name AS label, ${tier('e.name')} AS tier,
           (SELECT COUNT(*) FROM \`special_event_templates\` j JOIN \`template_families\` f ON f.id = j.family_id
             WHERE j.event_id = e.id AND ${live('f')}) AS uses
         FROM \`special_events\` e
         WHERE e.is_active = 1 AND ${matches('e.name')}
         HAVING uses > 0 ORDER BY tier, uses DESC, label LIMIT :cap`),
    run(`SELECT c.name AS label, ${tier('c.name')} AS tier,
           (SELECT COUNT(*) FROM \`template_families\` f JOIN \`template_categories\` fc ON fc.id = f.category_id
             WHERE fc.is_active = 1 AND (fc.id = c.id OR fc.parent_id = c.id) AND ${live('f')}) AS uses
         FROM \`template_categories\` c
         WHERE c.is_active = 1 AND ${matches('c.name')}
         HAVING uses > 0 ORDER BY tier, uses DESC, label LIMIT :cap`),
    run(`SELECT b.name AS label, ${tier('b.name')} AS tier,
           (SELECT COUNT(DISTINCT j.family_id) FROM \`template_business_categories\` j
              JOIN \`business_categories\` jb ON jb.id = j.business_category_id
              JOIN \`template_families\` f ON f.id = j.family_id
             WHERE jb.is_active = 1 AND (jb.id = b.id OR jb.parent_id = b.id) AND ${live('f')}) AS uses
         FROM \`business_categories\` b
         WHERE b.is_active = 1 AND ${matches('b.name')}
         HAVING uses > 0 ORDER BY tier, uses DESC, label LIMIT :cap`),
    run(`SELECT t.name AS label, ${tier('t.name')} AS tier,
           (SELECT COUNT(*) FROM \`template_tags\` j JOIN \`template_families\` f ON f.id = j.family_id
             WHERE j.tag_id = t.id AND ${live('f')}) AS uses
         FROM \`tags\` t
         WHERE ${matches('t.name')}
         HAVING uses > 0 ORDER BY tier, uses DESC, label LIMIT :cap`),
    run(`SELECT f.name AS label, ${tier('f.name')} AS tier
         FROM \`template_families\` f
         WHERE (${matches('f.name')} OR ${matches('f.search_keywords')} OR f.search_keywords LIKE :keywordPrefix)
           AND ${live('f')}
         ORDER BY tier, f.trending_score DESC, f.id DESC LIMIT :designCap`),
  ]);

  const byType = { event: events, category: categories, industry: industries, tag: tags, design: designs };
  const candidates = TYPE_ORDER.flatMap((type, typeRank) =>
    byType[type].map((row, i) => ({ type, label: row.label, tier: Number(row.tier), typeRank, i })));
  candidates.sort((a, b) => a.tier - b.tier || a.typeRank - b.typeRank || a.i - b.i);

  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = c.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: c.type, label: c.label, query: toQuery(c.label) });
    if (out.length === limit) break;
  }
  return out;
}

module.exports = { suggest };
