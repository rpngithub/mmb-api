// Bulk template import — a manifest of versions, files uploaded by the admin panel
// straight to S3, tracked as a batch. Full design: docs/template-bulk-import-design.md.
//
// The admin panel drives every step; nothing here runs in the background. The
// batch + item rows are the durable state, so each step can be repeated safely
// (a dropped connection, a closed tab, a laptop that slept) and simply resumes:
//
//   create   POST /admin/template-imports                 manifest → items (dry run, part 1)
//   replace  PUT  /admin/template-imports/:uid/manifest   new manifest → items afresh (before start only)
//   files    POST /admin/template-imports/:uid/files      file inventory + design.json per row (dry run, part 2)
//   start    POST /admin/template-imports/:uid/start      draft families + versions
//   presign  POST /admin/template-imports/:uid/items/:row/presign
//   complete POST /admin/template-imports/:uid/items/:row/complete
//   finalize POST /admin/template-imports/:uid/finalize   publish families that are ready
//   cancel   DELETE /admin/template-imports/:uid          remove this batch's drafts
//
// Publishing never bypasses the gate: a version / family goes live only when
// templatePublish's own checklist is empty, otherwise it stays a draft and the
// reasons are reported.
const { Op } = require('sequelize');
const models = require('../models');
const s3 = require('../utils/s3Helper');
const slugify = require('../utils/slugify');
const { parse, csvLine } = require('../utils/csv');
const { normalizeKeywords, KEYWORD_MAX, KEYWORDS_MAX, KEYWORDS_STORED } = require('../utils/textSearch');
const uploadLimits = require('./uploadLimits.service');
const { EXTENSIONS, typeForExtension, kindOfType } = require('../constants/uploadTypes');
const publish = require('./templatePublish');
const activity = require('./activity.service');
const { ValidationError, NotFoundError, ConflictError } = require('../errors');

const {
  sequelize, TemplateImportBatch, TemplateImportItem, TemplateFamily, Template,
  TemplateCategory, BusinessCategory, Tag, Language, TemplateSize,
} = models;

// ---- Limits (see the design doc, §7) ----
const LIMITS = {
  max_rows:          300,
  max_families:      100,
  max_files:         3000,
  max_total_bytes:   1024 * 1024 * 1024,
  files_chunk:       25,
  max_content_bytes: 2 * 1024 * 1024,
  // Files above this go through the existing multipart endpoints.
  multipart_over:    100 * 1024 * 1024,
};
const PAUSED_AFTER_MS = 30 * 60 * 1000;
const PRESIGN_EXPIRES = 900;

// ---- Manifest columns ----
const COLUMNS = [
  'family_name', 'category', 'industries', 'tags', 'is_premium', 'template_type', 'search_keywords',
  'language', 'size', 'folder', 'thumbnail',
];
const REQUIRED_COLUMNS = ['family_name', 'size', 'folder'];
// Shared by every version of a design. Rows of one design may leave them blank
// after the first; two different non-blank values are an error.
const DESIGN_COLUMNS = ['category', 'industries', 'tags', 'is_premium', 'template_type', 'search_keywords'];
const LIST_COLUMNS = ['industries', 'tags', 'search_keywords'];
const TEMPLATE_TYPES = ['image', 'video', 'animated'];
// Only for rows checked before the thumbnail was detected from the bundle.
const DEFAULT_THUMBNAIL = 'thumbnail.png';
// How messages name the design file: a bundle may call its one .json anything.
const DESIGN_FILE = 'the design JSON';
const ENGLISH = 'en';

// ---- Bundle files ----
// A row's bundle is a ZIP the admin panel reads in the browser, or a plain folder.
// Either way the server sees a flat list of file names plus the design JSON text.
// Every string in the design JSON with one of these extensions (and no path) is a
// file the design uses, so it should be in the bundle (see extractReferences for
// URLs, paths and display names). Fonts are deliberately absent: they come from
// the fonts library and are not checked (decision, 2026-11-21).
const MEDIA_EXTS = Object.values(EXTENSIONS).flat();
const OTHER_EXTS = ['json', 'mp3', 'wav', 'm4a', 'aac', 'ogg'];
const REF_EXTS = [...MEDIA_EXTS, ...OTHER_EXTS];
const FONT_EXTS = ['ttf', 'otf', 'woff', 'woff2'];
const UPLOADABLE_EXTS = [...REF_EXTS, ...FONT_EXTS];
const THUMBNAIL_EXTS = ['png', 'jpg', 'jpeg', 'webp'];

// The bundle's thumbnail when the manifest cell is blank: thumbnail.png, else .jpg …
const findThumbnail = (names) => THUMBNAIL_EXTS
  .map((e) => names.find((n) => n.toLowerCase() === `thumbnail.${e}`))
  .find(Boolean) || null;

const extOf = (name) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};
const isBareName = (s) => typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\\/]/.test(s) && s !== '.' && s !== '..';
// The upload key keeps the name only if it is already safe (upload.service's
// safeName). A name it would rewrite breaks the design's reference to it.
const isSafeName = (s) => /^[\w.-]+$/.test(s) && s.length <= 120;

const cell = (v) => String(v == null ? '' : v).trim();
const splitList = (v) => {
  const seen = new Set();
  const out = [];
  for (const part of cell(v).split('|').map((p) => p.trim()).filter(Boolean)) {
    const k = part.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(part); }
  }
  return out;
};
const sameKey = (col, v) => (LIST_COLUMNS.includes(col)
  ? splitList(v).map((x) => x.toLowerCase()).sort().join('|')
  : cell(v).toLowerCase());
const familyKey = (name) => cell(name).toLowerCase();

const err = (scope, field, message) => ({ scope, field, message });
const warn = (scope, field, message, level = 'warning') => ({ scope, field, message, level });

// Keys whose value is a label shown to the designer, not where the file is loaded
// from. The editor's export keeps the original upload name here (data.name =
// "pattern.png") while src / sourceUrl point at the stored, UUID-named file.
const LABEL_KEYS = new Set([
  'name', 'title', 'label', 'alt', 'caption', 'description',
  'displayname', 'display_name', 'originalname', 'original_name', 'filename', 'file_name',
]);
const WEB_URL_RE = /^(https?:)?\/\//i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

// "./a/b.png", ".\\b.png" → "a/b.png", "b.png". Names stay case-sensitive.
const normalizePath = (s) => s.replace(/\\/g, '/').replace(/^(\.\/)+/, '');

// The file name at the end of a web URL, without query or fragment.
function urlFileName(s) {
  const path = s.replace(WEB_URL_RE, '').replace(/[?#].*$/, '');
  const slash = path.indexOf('/');
  if (slash < 0) return null;
  const last = path.slice(path.lastIndexOf('/') + 1);
  try { return decodeURIComponent(last); } catch { return last; }
}

/**
 * What design.json refers to, walking every string value in the tree:
 *   files  — bare `name.ext` (or `./name.ext`) with a media/json/audio extension:
 *            REQUIRED in the bundle (missing = a warning, see checkFiles).
 *   fonts  — bare font names: uploaded when present, never required.
 *   paths  — relative paths with folders (`assets/bg.png`): uploaded when their
 *            file name is in the bundle (bundles are flat), with a warning.
 *   urls   — http(s) URLs: [{ url, name }] where name = the URL's last segment.
 *            Uploaded when that name is in the bundle; otherwise a library or
 *            external file, never required.
 *   labels — bare names under display keys (name, title, originalName…): uploaded
 *            when present, never required, never reported.
 * Matching against the bundle is by exact, case-sensitive file name.
 */
function extractReferences(design) {
  const files = new Set();
  const fonts = new Set();
  const paths = new Set();
  const labels = new Set();
  const urls = new Map();
  const walk = (node, key) => {
    if (typeof node === 'string') {
      // Names with spaces count too: the file check then asks for a rename,
      // instead of the file being silently left out of the upload.
      const raw = node.trim();
      if (!raw || raw.length > 2000) return;
      if (WEB_URL_RE.test(raw)) {
        const name = urlFileName(raw);
        if (name && isBareName(name) && UPLOADABLE_EXTS.includes(extOf(name)) && !urls.has(raw)) urls.set(raw, { url: raw, name });
        return;
      }
      if (SCHEME_RE.test(raw)) return; // data:, blob:, …
      const s = normalizePath(raw);
      const e = extOf(s);
      if (!isBareName(s)) {
        if (s.length <= 500 && UPLOADABLE_EXTS.includes(e)) paths.add(raw);
        return;
      }
      if (key && LABEL_KEYS.has(String(key).toLowerCase())) {
        if (UPLOADABLE_EXTS.includes(e)) labels.add(s);
        return;
      }
      if (REF_EXTS.includes(e)) files.add(s);
      else if (FONT_EXTS.includes(e)) fonts.add(s);
    } else if (Array.isArray(node)) {
      node.forEach((n) => walk(n, key));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(design, null);
  return { files: [...files], fonts: [...fonts], paths: [...paths], urls: [...urls.values()], labels: [...labels] };
}

// ---- Reference lookups (slug / uid / legacy id / name) ----
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_RE = /^\d+$/;

async function findByRef(model, ref, { field = 'slug', hasUid = true, nameField = 'name', transaction } = {}) {
  const s = cell(ref);
  if (!s) return null;
  if (INT_RE.test(s)) return model.findByPk(Number(s), { transaction });
  if (hasUid && UUID_RE.test(s)) return model.findOne({ where: { uid: s }, transaction });
  let row = await model.findOne({ where: { [field]: s }, transaction });
  if (!row && nameField && nameField !== field) row = await model.findOne({ where: { [nameField]: s }, transaction });
  return row;
}

// Matched on the name, then on its slug — tags.slug is unique, so two spellings
// that slugify alike are one tag (same rule as the CSV importer).
async function findTag(name, transaction) {
  let tag = await Tag.findOne({ where: { name }, transaction });
  const slug = slugify(name) || null;
  if (!tag && slug) tag = await Tag.findOne({ where: { slug }, transaction });
  return tag;
}

async function findOrCreateTag(name, transaction) {
  const tag = await findTag(name, transaction);
  if (tag) return tag;
  return Tag.create({ name, slug: slugify(name) || null }, { transaction });
}

// ---- Manifest validation ----

function normalizeFolder(raw) {
  const s = cell(raw).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!s) return { error: 'folder is required' };
  if (s.length > 500) return { error: 'folder path is longer than 500 characters' };
  if (s.split('/').some((p) => p === '..' || p === '.')) return { error: 'folder may not contain . or .. segments' };
  return { folder: s };
}

/**
 * Validates manifest rows against the catalog. `rows` = [{ row_no, values }].
 * Returns { rows: Map(row_no → { errors, notes, resolved }), families: Map(key → {...}) }.
 * Read-only: nothing is created here (unknown tags are only reported).
 */
async function validateRows(rows) {
  const out = new Map();
  const families = new Map();
  for (const r of rows) {
    out.set(r.row_no, { errors: [], notes: [], resolved: {} });
    const key = familyKey(r.values.family_name);
    if (!families.has(key)) families.set(key, { name: cell(r.values.family_name), rows: [], errors: [], notes: [] });
    families.get(key).rows.push(r);
  }

  const langCache = new Map();
  const sizeCache = new Map();
  const folders = new Map();

  // Version-level columns.
  for (const r of rows) {
    const res = out.get(r.row_no);
    const v = r.values;
    const name = cell(v.family_name);
    if (!name) res.errors.push(err('manifest', 'family_name', 'family_name is required'));
    else if (name.length > 200) res.errors.push(err('manifest', 'family_name', 'family_name is longer than 200 characters'));

    const f = normalizeFolder(v.folder);
    if (f.error) res.errors.push(err('manifest', 'folder', f.error));
    else {
      const k = f.folder.toLowerCase();
      if (folders.has(k)) res.errors.push(err('manifest', 'folder', `folder is already used by row ${folders.get(k)} — every version needs its own folder`));
      else folders.set(k, r.row_no);
      res.resolved.folder = f.folder;
    }

    // Blank = found in the bundle once its files are known (checkFiles).
    const thumb = cell(v.thumbnail) || null;
    if (!thumb) { /* nothing to check yet */ } else if (!isBareName(thumb)) res.errors.push(err('manifest', 'thumbnail', 'thumbnail must be a file name inside the ZIP or folder, not a path'));
    else if (!THUMBNAIL_EXTS.includes(extOf(thumb))) res.errors.push(err('manifest', 'thumbnail', `thumbnail must be ${THUMBNAIL_EXTS.map((x) => `.${x}`).join(', ')}`));
    else if (!isSafeName(thumb)) res.errors.push(err('manifest', 'thumbnail', 'thumbnail name may only use letters, digits, ".", "_" and "-"'));
    res.resolved.thumbnail = thumb;

    const langRef = cell(v.language);
    if (!langRef) {
      res.resolved.language_id = null;
      res.resolved.language_code = null;
    } else {
      if (!langCache.has(langRef)) langCache.set(langRef, await findByRef(Language, langRef, { field: 'code' }));
      const lang = langCache.get(langRef);
      if (!lang) res.errors.push(err('manifest', 'language', `language "${langRef}" not found`));
      else { res.resolved.language_id = lang.id; res.resolved.language_code = lang.code; }
    }

    const sizeRef = cell(v.size);
    if (!sizeRef) res.errors.push(err('manifest', 'size', 'size is required'));
    else {
      if (!sizeCache.has(sizeRef)) sizeCache.set(sizeRef, await findByRef(TemplateSize, sizeRef));
      const size = sizeCache.get(sizeRef);
      if (!size) res.errors.push(err('manifest', 'size', `size "${sizeRef}" not found`));
      else {
        res.resolved.size_id = size.id;
        res.resolved.size_label = size.slug || size.name;
        if (!size.is_active) res.notes.push(warn('manifest', 'size', `size "${sizeRef}" is inactive`));
      }
    }
  }

  // Design-level columns, once per design.
  for (const fam of families.values()) {
    if (!fam.name) continue;
    const merged = {};
    for (const col of DESIGN_COLUMNS) {
      const given = fam.rows.map((r) => cell(r.values[col])).filter(Boolean);
      const distinct = new Set(given.map((g) => sameKey(col, g)));
      if (distinct.size > 1) fam.errors.push(err('manifest', col, `rows of "${fam.name}" disagree on ${col}`));
      merged[col] = given[0] || '';
    }

    const design = { category_id: null, industry_ids: [], tags: [], template_type: 'image', is_premium: 0, search_keywords: [] };

    if (merged.category) {
      const c = await findByRef(TemplateCategory, merged.category);
      if (!c) fam.errors.push(err('manifest', 'category', `template category "${merged.category}" not found`));
      else design.category_id = c.id;
    }
    for (const ref of splitList(merged.industries)) {
      const ind = await findByRef(BusinessCategory, ref);
      if (!ind) fam.errors.push(err('manifest', 'industries', `industry "${ref}" not found`));
      else if (!design.industry_ids.includes(ind.id)) design.industry_ids.push(ind.id);
    }
    for (const name of splitList(merged.tags)) {
      if (name.length > 100) { fam.errors.push(err('manifest', 'tags', `tag "${name.slice(0, 30)}…" is longer than 100 characters`)); continue; }
      const tag = await findTag(name);
      design.tags.push({ name, id: tag ? tag.id : null });
      if (!tag) fam.notes.push(warn('manifest', 'tags', `will create tag "${name}"`, 'info'));
    }
    if (merged.template_type) {
      const t = merged.template_type.toLowerCase();
      if (!TEMPLATE_TYPES.includes(t)) fam.errors.push(err('manifest', 'template_type', `template_type must be one of: ${TEMPLATE_TYPES.join(', ')}`));
      else design.template_type = t;
    }
    if (merged.is_premium) {
      const p = merged.is_premium.toLowerCase();
      if (['1', 'true', 'yes', 'y'].includes(p)) design.is_premium = 1;
      else if (['0', 'false', 'no', 'n'].includes(p)) design.is_premium = 0;
      else fam.errors.push(err('manifest', 'is_premium', 'is_premium must be 1 or 0'));
    }
    if (merged.search_keywords) {
      const list = normalizeKeywords(splitList(merged.search_keywords));
      if (list.length > KEYWORDS_MAX) fam.errors.push(err('manifest', 'search_keywords', `at most ${KEYWORDS_MAX} search keywords`));
      else if (list.some((k) => k.length > KEYWORD_MAX)) fam.errors.push(err('manifest', 'search_keywords', `a search keyword is longer than ${KEYWORD_MAX} characters`));
      else if (list.join(',').length > KEYWORDS_STORED) fam.errors.push(err('manifest', 'search_keywords', `search keywords total more than ${KEYWORDS_STORED} characters`));
      else design.search_keywords = list;
    }
    fam.design = design;

    // An existing design: new versions join it (v1 never replaces one).
    const existing = await TemplateFamily.findOne({ where: { name: fam.name } });
    fam.existing = existing;
    let existingVersions = [];
    if (existing) {
      existingVersions = await Template.findAll({ where: { family_id: existing.id }, attributes: ['language_id', 'size_id'], raw: true });
      fam.notes.push(warn('manifest', 'family_name', `adds versions to the existing design "${existing.name}"; its settings are kept, tags and industries are added`, 'info'));
    }

    // Language kind: a design is all text-free or all languages.
    const resolvedRows = fam.rows.map((r) => ({ r, res: out.get(r.row_no) })).filter(({ res }) => res.resolved.language_id !== undefined);
    const textFree = resolvedRows.filter(({ res }) => res.resolved.language_id === null).length;
    const withLang = resolvedRows.length - textFree;
    if (textFree && withLang) {
      fam.errors.push(err('manifest', 'language', `"${fam.name}" mixes text-free rows (blank language) with language rows`));
    } else if (existingVersions.length && resolvedRows.length) {
      const existingTextFree = existingVersions.every((x) => x.language_id === null);
      if (existingTextFree && withLang) fam.errors.push(err('manifest', 'language', `the existing design "${fam.name}" is text-free; its versions cannot have a language`));
      if (!existingTextFree && textFree) fam.errors.push(err('manifest', 'language', `the existing design "${fam.name}" has languages; a text-free version cannot join it`));
    }

    // Slots: (language, size) unique within the design, in the batch and in the DB.
    const seen = new Map();
    for (const { r, res } of resolvedRows) {
      if (!res.resolved.size_id) continue;
      const slot = `${res.resolved.language_id ?? 'null'}:${res.resolved.size_id}`;
      if (seen.has(slot)) {
        res.errors.push(err('manifest', 'size', `same language and size as row ${seen.get(slot)}`));
        continue;
      }
      seen.set(slot, r.row_no);
      const taken = existingVersions.some((x) => (x.language_id ?? null) === res.resolved.language_id && x.size_id === res.resolved.size_id);
      if (taken) res.errors.push(err('manifest', 'size', `"${fam.name}" already has a version in this language and size (re-import does not replace versions)`));
    }
  }

  // A design-level error stops every row of that design.
  for (const fam of families.values()) {
    for (const r of fam.rows) {
      const res = out.get(r.row_no);
      res.errors.push(...fam.errors);
      res.notes.push(...fam.notes);
      res.family = fam;
    }
  }
  return { rows: out, families };
}

// ---- Batch access ----

async function loadBatch(uid, allowed) {
  const batch = await TemplateImportBatch.findOne({ where: { uid } });
  if (!batch) throw new NotFoundError('template import not found');
  if (allowed && !allowed.includes(batch.status)) {
    throw new ConflictError(`This import is ${batch.status}; that step is only allowed while it is ${allowed.join(' or ')}`);
  }
  return batch;
}

const touch = (batch, patch = {}) => batch.update({ ...patch, last_activity_at: new Date() });

async function loadItem(batch, rowNo) {
  const item = await TemplateImportItem.findOne({ where: { batch_id: batch.id, row_no: Number(rowNo) } });
  if (!item) throw new NotFoundError(`row ${rowNo} not found in this import`);
  return item;
}

const isPaused = (batch) => batch.status === 'running'
  && batch.last_activity_at && (Date.now() - new Date(batch.last_activity_at).getTime()) > PAUSED_AFTER_MS;

const keep = (list, scopes) => (list || []).filter((e) => !scopes.includes(e.scope));

// ---- Report ----

async function familyFacts(familyIds) {
  if (!familyIds.length) return new Map();
  const fams = await TemplateFamily.findAll({ where: { id: familyIds }, attributes: ['id', 'uid', 'name', 'status', 'category_id'] });
  const facts = new Map();
  for (const f of fams) {
    const [tags, industries, required] = await Promise.all([
      f.countTags(), f.countBusinessCategories(), publish.hasRequiredVersion(f.id),
    ]);
    facts.set(f.id, { uid: f.uid, name: f.name, status: f.status, anchor: Boolean(f.category_id) || industries > 0, tags: tags > 0, required });
  }
  return facts;
}

/**
 * The batch, every row, and per design what will (or did) happen. Before
 * finalize, each design carries the publish checks it is predicted to fail, so
 * the dry run already says "this one will be a draft, because…".
 */
async function buildReport(batch) {
  const items = await TemplateImportItem.findAll({
    where: { batch_id: batch.id }, order: [['row_no', 'ASC']],
    attributes: { exclude: ['content'] },
  });

  const templateIds = items.map((i) => i.template_id).filter(Boolean);
  const versions = templateIds.length
    ? await Template.findAll({ where: { id: templateIds }, attributes: ['id', 'uid', 'status'], raw: true }) : [];
  const versionById = new Map(versions.map((v) => [v.id, v]));

  // Designs: those the batch already points at, or an existing one by name.
  const groups = new Map();
  for (const it of items) {
    const key = familyKey(it.family_name);
    if (!groups.has(key)) groups.set(key, { name: it.family_name, items: [], family_id: null });
    const g = groups.get(key);
    g.items.push(it);
    if (it.family_id) g.family_id = it.family_id;
  }
  const unmatched = [...groups.values()].filter((g) => !g.family_id).map((g) => g.name);
  if (unmatched.length) {
    const found = await TemplateFamily.findAll({ where: { name: unmatched }, attributes: ['id', 'name'], raw: true });
    for (const f of found) {
      const g = groups.get(familyKey(f.name));
      if (g && !g.family_id) g.family_id = f.id;
    }
  }
  const facts = await familyFacts([...new Set([...groups.values()].map((g) => g.family_id).filter(Boolean))]);
  const outcomes = new Map(((batch.summary && batch.summary.families) || []).map((f) => [f.family_id, f]));

  const designs = [];
  for (const g of groups.values()) {
    const fact = g.family_id ? facts.get(g.family_id) : null;
    const live = g.items.filter((i) => !['invalid', 'failed', 'cancelled'].includes(i.stage));
    const first = (col) => (g.items.map((i) => cell(i.manifest && i.manifest.values && i.manifest.values[col])).find(Boolean) || '');
    const checks = [];
    if (!(first('category') || first('industries') || (fact && fact.anchor))) {
      checks.push(warn('publish', 'category_id', 'No category and no industry — the design will stay a draft'));
    }
    if (!(first('tags') || (fact && fact.tags))) {
      checks.push(warn('publish', 'tag_ids', 'No tags — the design will stay a draft'));
    }
    const hasRequiredRow = live.some((i) => {
      const code = i.manifest && i.manifest.resolved ? i.manifest.resolved.language_code : undefined;
      return code === null || code === ENGLISH;
    });
    if (!(hasRequiredRow || (fact && fact.required))) {
      checks.push(warn('publish', 'versions', 'No English or text-free version — the design will stay a draft'));
    }
    const lacking = live.filter((i) => missingOf(i).length).map((i) => i.row_no);
    if (lacking.length) {
      checks.push(warn('publish', 'files', `Row(s) ${lacking.join(', ')} use files that are not in the bundle — those versions and the design will stay drafts`));
    }
    const outcome = g.family_id ? outcomes.get(g.family_id) : null;
    designs.push({
      family_name:  g.name,
      family_uid:   fact ? fact.uid : null,
      family_status: fact ? fact.status : null,
      existing:     Boolean(fact) && !g.items.some((i) => i.created_family),
      rows:         g.items.map((i) => i.row_no),
      outcome:      outcome ? outcome.outcome : null,
      warnings:     outcome ? outcome.warnings : (live.length ? checks : []),
    });
  }

  const counts = {};
  for (const it of items) counts[it.stage] = (counts[it.stage] || 0) + 1;
  const files = items.reduce((a, i) => {
    for (const f of i.files || []) { a.count += 1; a.bytes += Number(f.size) || 0; }
    return a;
  }, { count: 0, bytes: 0 });

  return {
    uid:              batch.uid,
    label:            batch.label,
    status:           batch.status,
    is_paused:        isPaused(batch),
    total_items:      batch.total_items,
    counts,
    files,
    limits:           LIMITS,
    last_activity_at: batch.last_activity_at,
    started_at:       batch.started_at,
    finished_at:      batch.finished_at,
    created_at:       batch.created_at,
    designs,
    items: items.map((i) => {
      const v = i.template_id ? versionById.get(i.template_id) : null;
      const values = (i.manifest && i.manifest.values) || {};
      return {
        row:            i.row_no,
        line:           i.line,
        family_name:    i.family_name,
        language:       cell(values.language) || null,
        size:           cell(values.size) || null,
        folder:         i.folder,
        thumbnail:      i.manifest && i.manifest.resolved ? i.manifest.resolved.thumbnail : null,
        stage:          i.stage,
        result:         i.result,
        failed_stage:   i.failed_stage,
        template_uid:   v ? v.uid : null,
        template_status: v ? v.status : null,
        files:          (i.files || []).map((f) => ({ name: f.name, size: f.size })),
        errors:         i.errors || [],
        warnings:       i.warnings || [],
      };
    }),
  };
}

// ---- ① Create: parse the manifest, validate it, store the items ----

const MANIFEST_HELP = [
  '# Template bulk import manifest — one row per version (language × size). Lines starting with # are ignored.',
  '# family_name (required): groups rows into one design; an existing design with that name gets the new versions.',
  '# category / industries / tags / is_premium / template_type / search_keywords: the DESIGN\'s settings — repeat them or leave',
  '#   them blank after the first row of a design. Lists are separated by |. Unknown tags are created; categories and industries must exist.',
  '#   To publish, a design needs a category or an industry, at least one tag, and an English or text-free version.',
  '# language: code (en, hi, ta…); blank = text-free. size (required): size slug or uid.',
  '# folder (required): the version\'s ZIP bundle (or unzipped folder), relative to this file. It holds one design .json, the thumbnail and every file the design uses.',
  '# thumbnail: file name inside the ZIP (png/jpg/webp); blank = thumbnail.png, .jpg, .jpeg or .webp, whichever is there.',
];
const MANIFEST_EXAMPLE = [
  ['Diwali Sale 01', 'festival-offers', 'retail|restaurants', 'diwali|sale|festival', '0', 'image', 'diya|lamp', 'en', 'square-1080', 'diwali-sale-01-en-square.zip', 'thumbnail.png'],
  ['Diwali Sale 01', '', '', '', '', '', '', 'hi', 'square-1080', 'diwali-sale-01-hi-square.zip', ''],
];

function manifestTemplate({ example = false } = {}) {
  const lines = [...MANIFEST_HELP, csvLine(COLUMNS)];
  if (example) for (const row of MANIFEST_EXAMPLE) lines.push(`# ${csvLine(row)}`);
  return { filename: 'template-import-manifest.csv', content: `${lines.join('\n')}\n` };
}

/**
 * Parses and checks manifest.csv — shared by create and replace, so both apply
 * the same rules and limits. Returns the numbered rows, their check results and
 * any ignored columns. Throws a 400 for a manifest that cannot be used at all.
 * `row_no` is the 1-based index among data rows (comments and blank lines are
 * not counted); `line` is the CSV line number.
 */
async function parseManifest(manifest) {
  const { header, rows } = parse(manifest);
  if (!header.length) throw new ValidationError('The manifest is empty');
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new ValidationError('The manifest is missing required columns', missing.map((c) => ({ field: 'manifest', message: `column "${c}" is required` })));
  }
  if (!rows.length) throw new ValidationError('The manifest has no rows');
  if (rows.length > LIMITS.max_rows) {
    throw new ValidationError(`At most ${LIMITS.max_rows} rows per import (got ${rows.length}); split it into several imports`);
  }
  const familyCount = new Set(rows.map((r) => familyKey(r.values.family_name)).filter(Boolean)).size;
  if (familyCount > LIMITS.max_families) {
    throw new ValidationError(`At most ${LIMITS.max_families} designs per import (got ${familyCount}); split it into several imports`);
  }

  const unknown = header.filter((h) => h && !COLUMNS.includes(h));
  const numbered = rows.map((r, i) => {
    const values = {};
    for (const c of COLUMNS) values[c] = cell(r.values[c]);
    return { row_no: i + 1, line: r.line, values };
  });
  const { rows: checked } = await validateRows(numbered);
  return { numbered, checked, unknown };
}

// Item rows for a parsed manifest: accepted rows await their files, rejected ones are invalid.
const itemRows = (batchId, { numbered, checked }) => numbered.map((r) => {
  const res = checked.get(r.row_no);
  return {
    batch_id:    batchId,
    row_no:      r.row_no,
    line:        r.line,
    manifest:    { values: r.values, resolved: res.resolved },
    family_name: r.values.family_name.slice(0, 200) || '(blank)',
    folder:      (res.resolved.folder || r.values.folder || '').slice(0, 500),
    stage:       res.errors.length ? 'invalid' : 'awaiting_files',
    errors:      res.errors,
    warnings:    res.notes,
  };
});

async function createBatch({ label, manifest }, req) {
  const parsed = await parseManifest(manifest);
  const batch = await sequelize.transaction(async (transaction) => {
    const b = await TemplateImportBatch.create({
      label: label ? String(label).slice(0, 200) : null,
      created_by: req.user ? req.user.userId : null,
      status: 'draft',
      total_items: parsed.numbered.length,
      summary: parsed.unknown.length ? { ignored_columns: parsed.unknown } : null,
      last_activity_at: new Date(),
    }, { transaction });
    await TemplateImportItem.bulkCreate(itemRows(b.id, parsed), { transaction });
    return b;
  });

  await activity.log(req, { action: 'template_import.created', entityType: 'template_import', entityId: batch.id, metadata: { rows: parsed.numbered.length } });
  return buildReport(batch);
}

// ---- ①b Replace the manifest (before start only) ----

/**
 * Replaces every row with the new manifest's. Nothing in the catalog exists for
 * this import yet (start has not run), so the old rows — and the file checks
 * they carried, since a folder or ZIP may have changed — are simply dropped.
 * Rows are numbered afresh: `row` N is the Nth data row of the NEW manifest, so
 * adding or removing a row shifts the numbers of the rows after it.
 */
async function replaceManifest(uid, { manifest }, req) {
  const REPLACEABLE = ['draft', 'validated'];
  const refuse = (status) => new ConflictError(`This import is ${status}; its manifest can only be replaced before it is started`);
  const current = await loadBatch(uid);
  if (!REPLACEABLE.includes(current.status)) throw refuse(current.status);
  const parsed = await parseManifest(manifest);

  const { batch, previous } = await sequelize.transaction(async (transaction) => {
    // Re-read under a lock: a /start that ran meanwhile wins, and this refuses.
    const b = await TemplateImportBatch.findOne({ where: { uid }, lock: transaction.LOCK.UPDATE, transaction });
    if (!REPLACEABLE.includes(b.status)) throw refuse(b.status);
    const before = b.total_items;
    await TemplateImportItem.destroy({ where: { batch_id: b.id }, transaction });
    await TemplateImportItem.bulkCreate(itemRows(b.id, parsed), { transaction });
    const summary = { ...(b.summary || {}) };
    if (parsed.unknown.length) summary.ignored_columns = parsed.unknown;
    else delete summary.ignored_columns;
    await b.update({
      status: 'draft',
      total_items: parsed.numbered.length,
      summary: Object.keys(summary).length ? summary : null,
      last_activity_at: new Date(),
    }, { transaction });
    return { batch: b, previous: before };
  });

  await activity.log(req, {
    action: 'template_import.manifest_replaced', entityType: 'template_import', entityId: batch.id,
    metadata: { rows: parsed.numbered.length, previous_rows: previous },
  });
  return buildReport(batch);
}

// ---- ② Files: inventory + design JSON per row (the rest of the dry run) ----

function checkFiles(item, input, limits) {
  const errors = [];
  const warnings = [];
  // The manifest value, not the resolved one: a row sent again is detected afresh.
  const givenThumbnail = cell(item.manifest && item.manifest.values && item.manifest.values.thumbnail);

  const inventory = new Map();
  for (const f of input.files || []) {
    const name = cell(f.name);
    if (!isBareName(name)) { errors.push(err('files', 'files', `"${name}" must be a file name inside the bundle, not a path`)); continue; }
    if (inventory.has(name)) { errors.push(err('files', 'files', `"${name}" is listed twice`)); continue; }
    const size = Number(f.size);
    if (!Number.isInteger(size) || size <= 0) { errors.push(err('files', 'files', `"${name}" has no valid size`)); continue; }
    inventory.set(name, { name, size, content_type: f.content_type ? String(f.content_type).slice(0, 100) : null });
  }

  const thumbnail = givenThumbnail || findThumbnail([...inventory.keys()]);

  // The design JSON → the version's content.
  let design = null;
  const content = typeof input.content === 'string' ? input.content : null;
  if (content === null || !content.trim()) {
    errors.push(err('files', 'content', `${DESIGN_FILE} is missing`));
  } else if (Buffer.byteLength(content, 'utf8') > LIMITS.max_content_bytes) {
    errors.push(err('files', 'content', `${DESIGN_FILE} is larger than ${uploadLimits.toMb(LIMITS.max_content_bytes)} MB`));
  } else {
    try { design = JSON.parse(content); } catch { errors.push(err('files', 'content', `${DESIGN_FILE} is not valid JSON`)); }
    if (design !== null && typeof design !== 'object') { errors.push(err('files', 'content', `${DESIGN_FILE} must be a JSON object or array`)); design = null; }
  }

  // What gets uploaded: every referenced file, present fonts, and the thumbnail.
  const upload = new Map();
  const missing = [];
  if (design) {
    const refs = extractReferences(design);
    for (const name of refs.files) {
      if (inventory.has(name)) { upload.set(name, inventory.get(name)); continue; }
      // The thumbnail has its own error below; anything else is a warning only.
      // The row still imports, but its version and design stay drafts (see
      // completeItem / finalizeBatch) until the file is added.
      if (name === thumbnail) continue;
      missing.push(name);
      warnings.push(warn('files', 'files', `${DESIGN_FILE} uses "${name}", which is not in the bundle — it will not render until the file is added`));
    }
    for (const name of [...refs.fonts, ...refs.labels]) if (inventory.has(name)) upload.set(name, inventory.get(name));
    // Bundles are stored flat, so a path to a bundled file may not resolve in the
    // editor. Upload the file anyway — as the single upload does — and say so.
    for (const path of refs.paths) {
      const name = path.split(/[\\/]/).pop();
      if (!inventory.has(name)) continue;
      upload.set(name, inventory.get(name));
      warnings.push(warn('files', 'files', `${DESIGN_FILE} uses "${path}" with a path; files are stored flat, so it may not render — it should be just "${name}"`));
    }
    // The editor's export loads images by full URL (src / sourceUrl) whose last
    // segment is the bundled file's name. Upload the bundled copy; the design
    // itself still points at that URL, which is worth knowing (once per row).
    // A URL whose file is not bundled still loads from that URL, so it does not
    // block publishing — but the admin is told (once per file name; fonts excepted,
    // they come from the fonts library).
    const byUrl = new Map();
    const unbundled = new Set();
    for (const { url, name } of refs.urls) {
      const host = url.replace(WEB_URL_RE, '').split('/')[0];
      if (!inventory.has(name)) {
        if (FONT_EXTS.includes(extOf(name)) || unbundled.has(name)) continue;
        unbundled.add(name);
        warnings.push(warn('files', 'files', `${DESIGN_FILE} loads "${name}" from ${host}, which is not in the bundle — it will keep loading from that URL`));
        continue;
      }
      upload.set(name, inventory.get(name));
      if (!byUrl.has(host)) byUrl.set(host, new Set());
      byUrl.get(host).add(name);
    }
    for (const [host, names] of byUrl) {
      warnings.push(warn('files', 'files', `${DESIGN_FILE} loads ${names.size} bundled file(s) by full URL from ${host}; they are uploaded with the template, but the design keeps loading them from that URL`, 'info'));
    }
  }
  if (!thumbnail) errors.push(err('files', 'thumbnail', `no thumbnail in the bundle — add ${THUMBNAIL_EXTS.map((e) => `thumbnail.${e}`).join(' / ')}, or name it in the manifest's thumbnail column`));
  else if (!inventory.has(thumbnail)) errors.push(err('files', 'thumbnail', `thumbnail "${thumbnail}" is not in the bundle`));
  else upload.set(thumbnail, inventory.get(thumbnail));

  // The design file itself is listed too; it is saved as content, not uploaded.
  const jsons = [...inventory.keys()].filter((n) => extOf(n) === 'json' && !upload.has(n));
  const designName = jsons.find((n) => n.toLowerCase() === 'design.json') || (jsons.length === 1 ? jsons[0] : null);
  for (const name of inventory.keys()) {
    if (!upload.has(name) && name !== designName) warnings.push(warn('files', 'files', `"${name}" is not used by ${DESIGN_FILE} — not uploaded`));
  }

  // Each uploaded file: a name the S3 key keeps as-is, a known type, within limits.
  const files = [];
  for (const f of upload.values()) {
    const e = extOf(f.name);
    if (!isSafeName(f.name)) { errors.push(err('files', 'files', `"${f.name}": rename it using only letters, digits, ".", "_" and "-" (and update ${DESIGN_FILE})`)); continue; }
    if (!UPLOADABLE_EXTS.includes(e)) { errors.push(err('files', 'files', `"${f.name}": .${e || '?'} files are not supported`)); continue; }
    const type = typeForExtension(e);
    const kind = kindOfType(type);
    if (kind) {
      if (!limits[kind].types.includes(type)) { errors.push(err('files', 'files', `"${f.name}": ${type} is not an allowed ${kind} type`)); continue; }
      if (f.size > limits[kind].max_bytes) { errors.push(err('files', 'files', `"${f.name}" is ${uploadLimits.toMb(f.size)} MB; the limit for ${kind}s is ${uploadLimits.toMb(limits[kind].max_bytes)} MB`)); continue; }
    } else if (f.size > limits.image.max_bytes) {
      errors.push(err('files', 'files', `"${f.name}" is ${uploadLimits.toMb(f.size)} MB; the limit is ${uploadLimits.toMb(limits.image.max_bytes)} MB`));
      continue;
    }
    files.push({ name: f.name, size: f.size, content_type: type || f.content_type || 'application/octet-stream' });
  }

  return { errors, warnings, files, thumbnail, missing, content: design ? content : null };
}

// Files the row's design JSON uses that its bundle lacks (set by the files step).
const missingOf = (item) => (item.manifest && item.manifest.resolved && item.manifest.resolved.missing_files) || [];
const missingMessage = (names) => `${names.length} file(s) the design JSON uses are not in the bundle: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`;

async function attachFiles(uid, { items: input }, req) {
  const batch = await loadBatch(uid, ['draft', 'validated']);
  if (!Array.isArray(input) || !input.length) throw new ValidationError('items is required');
  if (input.length > LIMITS.files_chunk) throw new ValidationError(`At most ${LIMITS.files_chunk} rows per call (got ${input.length})`);

  const limits = await uploadLimits.load('admin');
  const all = await TemplateImportItem.findAll({ where: { batch_id: batch.id }, attributes: { exclude: ['content'] } });
  const byRow = new Map(all.map((i) => [i.row_no, i]));

  const updates = [];
  for (const entry of input) {
    const item = byRow.get(Number(entry.row));
    if (!item) throw new ValidationError(`row ${entry.row} is not in this import`);
    const manifestErrors = (item.errors || []).filter((e) => e.scope === 'manifest');
    const checked = checkFiles(item, entry, limits);
    const errors = [...manifestErrors, ...checked.errors];
    updates.push({
      item,
      patch: {
        files:    checked.files,
        manifest: { ...item.manifest, resolved: { ...item.manifest.resolved, thumbnail: checked.thumbnail, missing_files: checked.missing } },
        content:  checked.content,
        errors,
        warnings: [...keep(item.warnings, ['files']), ...checked.warnings],
        stage:    errors.length ? 'invalid' : 'valid',
      },
    });
  }

  // Batch-wide caps, counting what the other rows already hold.
  const changed = new Set(updates.map((u) => u.item.id));
  let count = 0;
  let bytes = 0;
  for (const i of all) {
    if (changed.has(i.id)) continue;
    for (const f of i.files || []) { count += 1; bytes += f.size; }
  }
  for (const u of updates) for (const f of u.patch.files) { count += 1; bytes += f.size; }
  if (count > LIMITS.max_files) throw new ValidationError(`At most ${LIMITS.max_files} files per import (this one would have ${count})`);
  if (bytes > LIMITS.max_total_bytes) {
    throw new ValidationError(`At most ${uploadLimits.toMb(LIMITS.max_total_bytes)} MB per import (this one would have ${uploadLimits.toMb(bytes)} MB)`);
  }

  await sequelize.transaction(async (transaction) => {
    for (const u of updates) await u.item.update(u.patch, { transaction });
  });

  const waiting = await TemplateImportItem.count({ where: { batch_id: batch.id, stage: 'awaiting_files' } });
  await touch(batch, { status: waiting ? 'draft' : 'validated' });
  return buildReport(batch);
}

// ---- ③ Start: draft families + versions ----

async function startBatch(uid, req) {
  const batch = await loadBatch(uid);
  if (batch.status === 'draft') {
    const waiting = await TemplateImportItem.count({ where: { batch_id: batch.id, stage: 'awaiting_files' } });
    throw new ConflictError(`${waiting} row(s) have no files yet — send their files first`);
  }
  if (!['validated', 'running'].includes(batch.status)) {
    throw new ConflictError(`This import is ${batch.status}; it cannot be started`);
  }

  // Only rows still `valid` — a repeated start skips what was already created.
  const pending = await TemplateImportItem.findAll({ where: { batch_id: batch.id, stage: 'valid' }, order: [['row_no', 'ASC']] });
  const everValid = await TemplateImportItem.count({ where: { batch_id: batch.id, stage: { [Op.notIn]: ['invalid', 'awaiting_files'] } } });
  if (!everValid) throw new ConflictError('No row is valid — fix the ZIPs or folders and send the files again');

  await touch(batch, { status: 'running', started_at: batch.started_at || new Date() });

  // Re-check against the catalog as it is NOW (a tag or category may have gone).
  const { rows: checked } = await validateRows(pending.map((i) => ({ row_no: i.row_no, values: i.manifest.values })));
  const groups = new Map();
  for (const item of pending) {
    const res = checked.get(item.row_no);
    if (res.errors.length) {
      await item.update({ stage: 'invalid', errors: [...keep(item.errors, ['manifest']), ...res.errors] });
      continue;
    }
    const key = familyKey(item.family_name);
    if (!groups.has(key)) groups.set(key, { fam: res.family, items: [] });
    groups.get(key).items.push({ item, res });
  }

  const createdBy = req.user ? req.user.userId : null;
  for (const { fam, items } of groups.values()) {
    try {
      await sequelize.transaction(async (transaction) => {
        const tags = [];
        for (const t of fam.design.tags) tags.push(await findOrCreateTag(t.name, transaction));

        let family = await TemplateFamily.findOne({ where: { name: fam.name }, transaction });
        let createdFamily = 0;
        if (!family) {
          family = await TemplateFamily.create({
            name:            fam.name,
            category_id:     fam.design.category_id,
            template_type:   fam.design.template_type,
            is_premium:      fam.design.is_premium,
            search_keywords: fam.design.search_keywords,
            status:          'draft',
            created_by:      createdBy,
          }, { transaction });
          createdFamily = 1;
          if (tags.length) await family.setTags(tags, { transaction });
          if (fam.design.industry_ids.length) await family.setBusinessCategories(fam.design.industry_ids, { transaction });
        } else {
          // An existing design keeps its settings; the manifest only adds to it.
          if (tags.length) await family.addTags(tags, { transaction });
          if (fam.design.industry_ids.length) await family.addBusinessCategories(fam.design.industry_ids, { transaction });
          if (!family.category_id && fam.design.category_id) await family.update({ category_id: fam.design.category_id }, { transaction });
        }

        for (const { item, res } of items) {
          const payload = { family_id: family.id, language_id: res.resolved.language_id, size_id: res.resolved.size_id };
          const version = await Template.create({
            ...payload, name: family.name, status: 'draft', created_by: createdBy,
          }, { transaction });
          await item.update({
            family_id: family.id, template_id: version.id,
            created_family: createdFamily, created_version: 1,
            stage: 'created', failed_stage: null,
          }, { transaction });
        }
      });
    } catch (e) {
      const message = e.name === 'SequelizeUniqueConstraintError'
        ? 'a version in this language and size was created meanwhile'
        : (e.isOperational ? e.message : 'could not create the design');
      if (!e.isOperational && e.name !== 'SequelizeUniqueConstraintError') console.error('[template-import] start failed:', e);
      for (const { item } of items) {
        await item.update({ stage: 'failed', failed_stage: 'start', errors: [...keep(item.errors, ['start']), err('start', 'family_name', message)] });
      }
    }
  }

  await touch(batch);
  await activity.log(req, { action: 'template_import.started', entityType: 'template_import', entityId: batch.id, metadata: { rows: pending.length } });
  return buildReport(batch);
}

// ---- ④ Presign one row's files ----

const ITEM_ACTIVE = ['running', 'completed', 'completed_with_issues'];
const prefixOf = (templateUid) => `templates/${templateUid}/`;

async function versionOf(item) {
  const tpl = item.template_id ? await Template.findByPk(item.template_id) : null;
  if (!tpl) {
    await item.update({ stage: 'failed', failed_stage: 'upload', errors: [...keep(item.errors, ['upload']), err('upload', 'template', 'the version was deleted')] });
    throw new ConflictError(`row ${item.row_no}: its version no longer exists`);
  }
  return tpl;
}

async function presignItem(uid, rowNo, req) {
  const batch = await loadBatch(uid, ITEM_ACTIVE);
  const item = await loadItem(batch, rowNo);
  const canUpload = ['created', 'uploading'].includes(item.stage)
    || (item.stage === 'failed' && ['upload', 'complete'].includes(item.failed_stage));
  if (!canUpload) throw new ConflictError(`row ${item.row_no} is ${item.stage}; it has nothing to upload`);
  const tpl = await versionOf(item);

  // Resume: a file already in S3 at the declared size is not asked for again.
  const prefix = prefixOf(tpl.uid);
  const present = new Map((await s3.listObjects(prefix)).map((o) => [o.key, o.size]));
  const files = [];
  const already = [];
  for (const f of item.files || []) {
    const key = `${prefix}${f.name}`;
    if (present.get(key) === f.size) { already.push(f.name); continue; }
    if (f.size > LIMITS.multipart_over) {
      files.push({
        name: f.name, key, size: f.size, content_type: f.content_type, upload_method: 'multipart',
        target: { type: 'template_file', template_uid: tpl.uid },
      });
      continue;
    }
    files.push({
      name: f.name, key, size: f.size, content_type: f.content_type, upload_method: 'single',
      upload_url: await s3.getPresignedPutUrl(key, f.content_type, { contentLength: f.size, expiresIn: PRESIGN_EXPIRES }),
      required_headers: { 'x-amz-tagging': 'status=pending', 'Content-Type': f.content_type },
    });
  }

  await item.update({ stage: 'uploading' });
  await touch(batch);
  return { row: item.row_no, template_uid: tpl.uid, files, already_uploaded: already, expires_in: PRESIGN_EXPIRES };
}

// ---- ⑤ Complete one row ----

async function completeItem(uid, rowNo, req) {
  const batch = await loadBatch(uid, ITEM_ACTIVE);
  const item = await loadItem(batch, rowNo);
  if (item.stage === 'completed') return itemResult(item);
  const canComplete = ['created', 'uploading'].includes(item.stage)
    || (item.stage === 'failed' && ['upload', 'complete'].includes(item.failed_stage));
  if (!canComplete) throw new ConflictError(`row ${item.row_no} is ${item.stage}; it cannot be completed`);
  const tpl = await versionOf(item);
  const content = (await TemplateImportItem.findByPk(item.id, { attributes: ['content'] })).content;

  const prefix = prefixOf(tpl.uid);
  const present = new Map((await s3.listObjects(prefix)).map((o) => [o.key, o.size]));
  const problems = [];
  for (const f of item.files || []) {
    const size = present.get(`${prefix}${f.name}`);
    if (size === undefined) problems.push(err('upload', 'files', `"${f.name}" has not been uploaded`));
    else if (size !== null && size !== f.size) problems.push(err('upload', 'files', `"${f.name}" is ${size} bytes in storage, expected ${f.size}`));
  }
  // The first bytes must match the extension (images and videos).
  if (!problems.length) {
    for (const f of item.files || []) {
      const type = typeForExtension(extOf(f.name));
      if (!type || !uploadLimits.hasSignature(type)) continue;
      const start = await s3.readObjectStart(`${prefix}${f.name}`, uploadLimits.SNIFF_BYTES);
      if (start && !uploadLimits.matchesSignature(type, start)) problems.push(err('upload', 'files', `"${f.name}" is not a valid ${type} file`));
    }
  }
  if (problems.length) {
    await item.update({ stage: 'failed', failed_stage: 'upload', errors: [...keep(item.errors, ['upload', 'complete']), ...problems] });
    await touch(batch);
    return itemResult(item);
  }

  for (const f of item.files || []) await s3.putObjectTagging(`${prefix}${f.name}`, 'active');

  const thumbnail = item.manifest.resolved.thumbnail || DEFAULT_THUMBNAIL;
  await tpl.update({ content, thumbnail_s3_key: `${prefix}${thumbnail}` });
  const missing = publish.missingForVersion(tpl);
  // A design JSON that uses files the bundle lacks would render broken: never auto-publish it.
  const lackingFiles = missingOf(item);
  if (lackingFiles.length) missing.push({ field: 'files', message: missingMessage(lackingFiles) });
  let result = 'draft';
  if (!missing.length) {
    if (tpl.status !== 'active') await tpl.update({ status: 'active' });
    result = 'published';
  }
  await item.update({
    stage: 'completed', result, failed_stage: null,
    errors: keep(item.errors, ['upload', 'complete']),
    warnings: [...keep(item.warnings, ['publish']), ...missing.map((m) => warn('publish', m.field, `version kept as draft: ${m.message}`))],
  });
  await touch(batch);
  return itemResult(item, tpl);
}

const itemResult = (item, tpl) => ({
  row: item.row_no,
  stage: item.stage,
  result: item.result,
  failed_stage: item.failed_stage,
  template_uid: tpl ? tpl.uid : null,
  errors: item.errors || [],
  warnings: item.warnings || [],
});

// ---- ⑥ Finalize: publish the designs that are ready ----

async function finalizeBatch(uid, req) {
  const batch = await loadBatch(uid, ITEM_ACTIVE);
  const items = await TemplateImportItem.findAll({ where: { batch_id: batch.id }, attributes: { exclude: ['content'] } });
  const familyIds = [...new Set(items.map((i) => i.family_id).filter(Boolean))];

  const families = [];
  for (const id of familyIds) {
    const family = await TemplateFamily.findByPk(id);
    if (!family) { families.push({ family_id: id, outcome: 'deleted', warnings: [] }); continue; }
    if (family.status === 'active') {
      families.push({ family_id: id, uid: family.uid, name: family.name, outcome: 'already_live', warnings: [] });
      continue;
    }
    const missing = await publish.missingForFamily(family);
    // Its versions from this import that use files the bundle lacks — unless the
    // admin has since fixed and published that version by hand.
    const lacking = [];
    for (const i of items) {
      if (i.family_id !== id || !i.template_id || !missingOf(i).length) continue;
      const v = await Template.findByPk(i.template_id, { attributes: ['status'] });
      if (v && v.status !== 'active') lacking.push(i.row_no);
    }
    if (lacking.length) missing.push({ field: 'files', message: `row(s) ${lacking.join(', ')} use files that are not in the bundle` });
    if (!missing.length) {
      await family.update({ status: 'active' });
      families.push({ family_id: id, uid: family.uid, name: family.name, outcome: 'published', warnings: [] });
    } else {
      families.push({
        family_id: id, uid: family.uid, name: family.name, outcome: 'draft',
        warnings: missing.map((m) => warn('publish', m.field, `design kept as draft: ${m.message}`)),
      });
    }
  }

  const clean = items.every((i) => i.stage === 'completed' && i.result === 'published')
    && families.every((f) => ['published', 'already_live'].includes(f.outcome));
  const counts = {
    published_versions: items.filter((i) => i.result === 'published').length,
    draft_versions:     items.filter((i) => i.result === 'draft').length,
    not_imported:       items.filter((i) => i.stage !== 'completed').length,
    published_designs:  families.filter((f) => f.outcome === 'published').length,
    draft_designs:      families.filter((f) => f.outcome === 'draft').length,
  };
  await touch(batch, {
    status: clean ? 'completed' : 'completed_with_issues',
    finished_at: new Date(),
    summary: { ...(batch.summary || {}), families, counts },
  });
  await activity.log(req, { action: 'template_import.finalized', entityType: 'template_import', entityId: batch.id, metadata: counts });
  return buildReport(batch);
}

// ---- Cancel: remove only this batch's drafts ----

async function cancelBatch(uid, req) {
  const batch = await loadBatch(uid);
  if (batch.status === 'cancelled') return buildReport(batch);
  const items = await TemplateImportItem.findAll({ where: { batch_id: batch.id }, attributes: { exclude: ['content'] } });

  let removedVersions = 0;
  let removedFamilies = 0;
  for (const item of items) {
    if (!item.created_version || !item.template_id) continue;
    const tpl = await Template.findByPk(item.template_id);
    if (!tpl || tpl.status === 'active') continue;
    try {
      await s3.deleteByPrefix(prefixOf(tpl.uid));
    } catch (e) {
      console.warn(`[template-import] could not delete ${prefixOf(tpl.uid)}: ${e.message}`);
    }
    await tpl.destroy();
    removedVersions += 1;
  }
  const createdFamilies = [...new Set(items.filter((i) => i.created_family && i.family_id).map((i) => i.family_id))];
  for (const id of createdFamilies) {
    const family = await TemplateFamily.findByPk(id);
    if (!family || family.status === 'active') continue;
    if (await Template.count({ where: { family_id: id } })) continue;
    await sequelize.transaction(async (transaction) => {
      await family.setTags([], { transaction });
      await family.setBusinessCategories([], { transaction });
      await family.destroy({ transaction });
    });
    removedFamilies += 1;
  }

  await TemplateImportItem.update({ stage: 'cancelled' }, { where: { batch_id: batch.id, stage: { [Op.ne]: 'completed' } } });
  await touch(batch, {
    status: 'cancelled', finished_at: new Date(),
    summary: { ...(batch.summary || {}), cancelled: { removed_versions: removedVersions, removed_designs: removedFamilies } },
  });
  await activity.log(req, { action: 'template_import.cancelled', entityType: 'template_import', entityId: batch.id, metadata: { removed_versions: removedVersions, removed_designs: removedFamilies } });
  return buildReport(batch);
}

// ---- Reads ----

async function getBatch(uid) {
  return buildReport(await loadBatch(uid));
}

async function listBatches({ limit = 20, offset = 0, status } = {}) {
  const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const o = Math.max(parseInt(offset, 10) || 0, 0);
  const where = {};
  if (status) where.status = String(status);
  const { rows, count } = await TemplateImportBatch.findAndCountAll({
    where, order: [['created_at', 'DESC'], ['id', 'DESC']], limit: l, offset: o,
  });
  return {
    count,
    rows: rows.map((b) => ({
      uid: b.uid, label: b.label, status: b.status, is_paused: isPaused(b), total_items: b.total_items,
      counts: b.summary && b.summary.counts ? b.summary.counts : null,
      created_by: b.created_by, last_activity_at: b.last_activity_at,
      started_at: b.started_at, finished_at: b.finished_at, created_at: b.created_at,
    })),
  };
}

module.exports = {
  LIMITS, COLUMNS,
  extractReferences, manifestTemplate,
  createBatch, replaceManifest, attachFiles, startBatch, presignItem, completeItem, finalizeBatch, cancelBatch,
  getBatch, listBatches,
};
