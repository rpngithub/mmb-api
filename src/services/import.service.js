const { v4: uuid } = require('uuid');
const models    = require('../models');
const slugify   = require('../utils/slugify');
const s3        = require('../utils/s3Helper');
const { parse, stripBom, csvLine } = require('../utils/csv');
const activity  = require('./activity.service');
const { ValidationError } = require('../errors');
const {
  createBusinessCategorySchema, updateBusinessCategorySchema,
  createTemplateCategorySchema, updateTemplateCategorySchema,
} = require('../validators/category.validator');
const { createVariantSchema, updateVariantSchema } = require('../validators/brandSeries.validator');

const { sequelize } = models;

// ---- Column kinds. `int`/`text` cells are passed as trimmed strings and coerced
//      by Joi; `bool` cells are normalized to 0/1 first (Joi.valid(0,1) won't take
//      "yes"). `parent`/`group`/`tags` are meta columns resolved outside Joi. ----
const coerceBool = (v) => {
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'active'].includes(s)) return 1;
  if (['0', 'false', 'no', 'n', 'inactive'].includes(s)) return 0;
  return v; // unrecognized -> let Joi reject with a clear message
};

// ---- Image (S3 key) columns. Editors upload the file to S3 themselves and paste
//      the key here; the importer never moves bytes. Every image check is
//      ADVISORY — a bad key is reported as a row warning and still imported, so a
//      typo never costs an editor the rest of the row. `NONE` clears the image,
//      blank leaves whatever is already stored. ----
const CLEAR_IMAGE = 'NONE';
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'svg'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const S3_CONCURRENCY = 15;

// ---- Per-entity import definitions. The `columns` list is the single source of
//      truth for both the CSV parser and the downloadable templates (no drift). ----
const ENTITIES = {
  industries: {
    label: 'Industries',
    entityType: 'business_category',
    permission: 'categories',
    model: () => models.BusinessCategory,
    createSchema: createBusinessCategorySchema,
    updateSchema: updateBusinessCategorySchema,
    hasUid: true,
    autoSlug: true,
    parentColumn: 'parent',
    tags: true,
    columns: ['name', 'parent', 'slug', 'icon_s3_key', 'thumbnail_s3_key', 'display_order', 'is_active', 'tags'],
    intColumns: ['display_order'],
    boolColumns: ['is_active'],
    textColumns: [],
    s3KeyColumns: {
      icon_s3_key:      'categories/business/icon/',
      thumbnail_s3_key: 'categories/business/thumbnail/',
    },
    help: [
      '# Industries import. Lines starting with # are ignored.',
      '# name (required): unique across all industries. parent: name or slug of another industry (blank = top level).',
      '# slug: optional (auto-generated from name if blank). is_active: 1 or 0. tags: pipe-separated, e.g. food|dining|offers',
    ],
    example: [
      ['Restaurants', '', 'restaurants', 'categories/business/icon/restaurants.svg', 'categories/business/thumbnail/restaurants.png', '1', '1', 'food|dining|offers'],
      ['Fine Dining', 'Restaurants', 'fine-dining', 'categories/business/icon/fine-dining.svg', '', '2', '1', 'premium|dining'],
      ['Retail', '', '', '', 'NONE', '3', '0', ''],
    ],
  },

  'template-categories': {
    label: 'Template categories',
    entityType: 'template_category',
    permission: 'categories',
    model: () => models.TemplateCategory,
    createSchema: createTemplateCategorySchema,
    updateSchema: updateTemplateCategorySchema,
    hasUid: true,
    autoSlug: true,
    parentColumn: 'parent',
    tags: false,
    columns: ['name', 'parent', 'slug', 'icon_s3_key', 'thumbnail_s3_key', 'show_in_homepage', 'display_order', 'is_active'],
    intColumns: ['display_order'],
    boolColumns: ['show_in_homepage', 'is_active'],
    textColumns: [],
    s3KeyColumns: {
      icon_s3_key:      'categories/template/icon/',
      thumbnail_s3_key: 'categories/template/thumbnail/',
    },
    help: [
      '# Template categories import. Lines starting with # are ignored.',
      '# name (required): unique across all template categories. parent: name/slug of another category (blank = top level).',
      '# slug: optional (auto from name). show_in_homepage / is_active: 1 or 0.',
    ],
    example: [
      ['Festivals', '', 'festivals', 'categories/template/icon/festivals.svg', 'categories/template/thumbnail/festivals.png', '1', '1', '1'],
      ['Diwali Greetings', 'Festivals', 'diwali-greetings', '', 'categories/template/thumbnail/diwali.png', '0', '2', '1'],
    ],
  },

  variants: {
    label: 'Variants',
    entityType: 'variant',
    permission: 'variants',
    model: () => models.Variant,
    createSchema: createVariantSchema,
    updateSchema: updateVariantSchema,
    hasUid: true,
    autoSlug: false,
    groupColumn: 'series',
    groupModel: () => models.BrandSeries,
    groupIdField: 'series_id',
    tags: false,
    columns: ['series', 'series_icon_s3_key', 'name', 'description', 'thumbnail_s3_key', 'display_order', 'is_active'],
    intColumns: ['display_order'],
    boolColumns: ['is_active'],
    textColumns: ['description'],
    // 'themes/' is accepted without a warning: thumbnails uploaded before the
    // Brand Series rename still live under that root.
    s3KeyColumns: { thumbnail_s3_key: ['variants/thumbnail/', 'themes/'] },
    groupS3Key: { column: 'series_icon_s3_key', field: 'icon_s3_key', prefix: 'brand-series/icon/' },
    help: [
      '# Variants import. Lines starting with # are ignored.',
      '# series (required): brand series name or slug — created automatically if it does not exist.',
      '# name (required): unique across all variants. is_active: 1 or 0.',
      '# series_icon_s3_key: icon for the SERIES, not the variant. Taken from the first row of each series,',
      '#   and only applied when the series has no icon yet (an existing icon is never overwritten).',
      '# Industries, plan entitlements and the badge are set from the admin UI, not this file.',
    ],
    example: [
      ['Lemon Buzz', 'brand-series/icon/lemon-buzz.svg', 'Lemon Buzz-01', 'Fresh and energetic', 'variants/thumbnail/lemon-buzz-01.png', '1', '1'],
      ['Lemon Buzz', '', 'Lemon Buzz-02', 'Bright citrus palette', 'variants/thumbnail/lemon-buzz-02.png', '2', '1'],
    ],
  },
};

// Deprecated entity key -> current key. Keeps /admin/imports/themes working for
// clients (and saved CSV workflows) written before the Brand Series rename.
const ENTITY_ALIASES = { themes: 'variants' };

const REFERENCE_SENTINEL = 'REFERENCE-ONLY';

function getEntity(key) {
  const cfg = ENTITIES[ENTITY_ALIASES[key] || key];
  if (!cfg) throw new ValidationError(`Unknown import entity: ${key}`);
  return cfg;
}

// ---- Image columns ----------------------------------------------------------

// Flatten an entity's image columns into one spec list. `scope` separates the
// row's own images from an image that belongs to the upserted group (a variant
// row carrying its brand series' icon).
const imageSpecs = (cfg) => [
  ...Object.entries(cfg.s3KeyColumns || {}).map(([column, prefixes]) => ({
    column, scope: 'row', prefixes: [].concat(prefixes),
  })),
  ...(cfg.groupS3Key
    ? [{ column: cfg.groupS3Key.column, scope: 'group', prefixes: [].concat(cfg.groupS3Key.prefix) }]
    : []),
];

// Editors paste whatever the S3 console or the CDN shows them. Reduce it to a
// bare key rather than rejecting it: strip the scheme+host (and the bucket
// segment of a path-style URL), the query string and any leading slash.
function normalizeS3Key(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/\\/g, '/');
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = decodeURIComponent(u.pathname);
      const bucket = process.env.S3_BUCKET_NAME;
      if (bucket && s.startsWith(`/${bucket}/`)) s = s.slice(bucket.length + 1);
    } catch { /* unparseable — fall through and treat the cell as a raw key */ }
  }
  return s.replace(/^\/+/, '');
}

// Offline checks: no S3 call, so these run even when the bucket is unreachable.
function shapeWarnings(spec, key) {
  const w = [];
  if (!spec.prefixes.some((p) => key.startsWith(p))) {
    w.push(`${spec.column}: expected a key under '${spec.prefixes[0]}' — imported as given, check the upload location`);
  }
  if (/\s/.test(key)) w.push(`${spec.column}: key contains a space`);
  if (key.includes('..')) w.push(`${spec.column}: key contains '..'`);
  const m = /\.([A-Za-z0-9]+)$/.exec(key);
  const e = m ? m[1].toLowerCase() : '';
  if (!IMAGE_EXTS.includes(e)) {
    w.push(`${spec.column}: '${e || 'no file extension'}' is not an image type (${IMAGE_EXTS.join(', ')})`);
  }
  return w;
}

// Run `fn` over the items with a capped number of in-flight S3 calls.
async function eachLimited(items, fn) {
  const pending = [...items];
  const worker = async () => {
    for (let it = pending.shift(); it !== undefined; it = pending.shift()) await fn(it);
  };
  await Promise.all(Array.from({ length: Math.min(S3_CONCURRENCY, pending.length) }, worker));
}

// HEAD every distinct key. A null probe means "could not check" (see
// s3Helper.objectExists) and is reported once as a note instead of as a per-row
// warning, so an unreachable bucket does not spam the report.
async function probeKeys(keys) {
  const probes = new Map();
  let unavailable = false;
  await eachLimited(keys, async (k) => {
    const r = await s3.objectExists(k);
    if (r === null) unavailable = true;
    else probes.set(k, r);
  });
  return { probes, unavailable };
}

// Mark the images this import put into use with the same `status=active` tag the
// presigned-upload flow applies on confirm. Editors upload straight from the S3
// console, so their objects arrive untagged; tagging them here keeps a
// pending-object lifecycle rule from ever treating a live image as garbage.
// Best-effort by design: a bucket that refuses tagging must not fail an import
// whose rows are already committed.
async function tagActive(keys) {
  let failed = 0;
  await eachLimited(keys, async (k) => {
    try { await s3.putObjectTagging(k, 'active'); } catch { failed += 1; }
  });
  return failed;
}

/**
 * Pass 0 over the parsed rows: normalize every image cell, collect advisory
 * warnings (shape, prefix, duplicate reuse, missing/oversized object) and hand
 * back the cleaned values keyed by source line.
 *
 * @returns {{ byLine: Map<number, { values, groupKey, warnings }>, notes: string[], missing: Set<string> }}
 */
async function prepareImages(cfg, rows) {
  const specs = imageSpecs(cfg);
  const byLine = new Map();
  const notes = [];
  const missing = new Set();   // probed and confirmed absent — never worth tagging later
  if (!specs.length) return { byLine, notes, missing };

  const firstSeen = new Map(); // key -> source line that used it first
  const distinct = new Set();

  for (const row of rows) {
    const entry = { values: {}, groupKey: undefined, warnings: [] };
    byLine.set(row.line, entry);

    for (const spec of specs) {
      const cell = String(row.values[spec.column] == null ? '' : row.values[spec.column]).trim();
      if (!cell) continue;                                  // blank -> leave as-is
      if (cell.toUpperCase() === CLEAR_IMAGE) {
        if (spec.scope === 'row') entry.values[spec.column] = null;
        continue;
      }

      const key = normalizeS3Key(cell);
      if (!key) continue;
      if (spec.scope === 'row') entry.values[spec.column] = key;
      else entry.groupKey = key;

      entry.warnings.push(...shapeWarnings(spec, key));

      // Group images legitimately repeat across a series' rows; only flag reuse
      // of a row-scoped image, which is nearly always a copy-paste slip.
      if (spec.scope === 'row') {
        if (firstSeen.has(key)) {
          const at = firstSeen.get(key);
          entry.warnings.push(at === row.line
            ? `${spec.column}: same image already used in another column on this row`
            : `${spec.column}: same image also used on line ${at}`);
        } else firstSeen.set(key, row.line);
      }
      distinct.add(key);
    }
  }

  if (!distinct.size) return { byLine, notes, missing };

  const { probes, unavailable } = await probeKeys(distinct);
  if (unavailable) notes.push('Some S3 keys could not be verified (bucket unreachable or not configured) — they were imported without an existence check.');

  for (const entry of byLine.values()) {
    const keys = [...Object.entries(entry.values).filter(([, v]) => v), ...(entry.groupKey ? [[cfg.groupS3Key.column, entry.groupKey]] : [])];
    for (const [column, key] of keys) {
      const probe = probes.get(key);
      if (!probe) continue;                                  // not checked
      if (!probe.exists) {
        missing.add(key);
        entry.warnings.push(`${column}: no such object in S3 ('${key}') — imported anyway`);
        continue;
      }
      if (probe.content_type && !/^image\//i.test(probe.content_type)) {
        entry.warnings.push(`${column}: object is '${probe.content_type}', not an image`);
      }
      if (probe.size != null && probe.size > MAX_IMAGE_BYTES) {
        entry.warnings.push(`${column}: object is ${Math.round(probe.size / 1024)} KB (over ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`);
      }
    }
  }

  return { byLine, notes, missing };
}

// ---- Template download (import + reference variants), built from `columns`. ----

// Image rules are generated from the entity's own spec so the help can never
// drift from what the importer actually accepts.
function imageHelp(cfg) {
  const specs = imageSpecs(cfg);
  if (!specs.length) return [];
  const lines = ['# Images: upload the file to S3 first, then paste its KEY here (a full https:// URL is accepted and trimmed to the key).'];
  for (const spec of specs) {
    const note = spec.scope === 'group' ? '   (only applied when the series has no icon yet)' : '';
    lines.push(`#   ${spec.column} -> ${spec.prefixes[0]}<filename>.${IMAGE_EXTS.join('|')}${note}`);
  }
  lines.push(`#   Blank = keep the current image. ${CLEAR_IMAGE} = remove the current image.`);
  lines.push('#   Image problems never skip a row: the row imports and the issue is listed under rows[].warnings in the response.');
  lines.push('#   Upload with dry_run=1 first to check every key before anything is written.');
  return lines;
}

function buildTemplate(key, { example = false } = {}) {
  const cfg = getEntity(key);
  const header = csvLine(cfg.columns);
  const lines = [];

  if (example) {
    lines.push(`# ${cfg.label} — ${REFERENCE_SENTINEL} — DO NOT IMPORT.`);
    lines.push('# For understanding the format only. Download the import template to add your data.');
    lines.push(...cfg.help.slice(1), ...imageHelp(cfg));
    lines.push(header);
    // Example data rows are #-commented so this file imports nothing even if uploaded.
    for (const row of cfg.example) lines.push(`# ${csvLine(row)}`);
  } else {
    lines.push(...cfg.help, ...imageHelp(cfg));
    lines.push(header);
  }

  const filename = example ? `${key}_EXAMPLE_do-not-import.csv` : `${key}_import_template.csv`;
  return { filename, content: `${lines.join('\r\n')}\r\n` };
}

// Build the Joi-validatable payload from a row's cells (schema fields only; slug,
// tags and the parent/group meta columns are handled separately). `images` holds
// the already-normalized S3 keys for this row (null = clear, absent = unchanged).
function buildPayload(cfg, values, { parentId, groupId, images }) {
  const payload = { name: (values.name || '').trim() };
  if (cfg.parentColumn && parentId != null) payload.parent_id = parentId;
  if (cfg.groupModel) payload[cfg.groupIdField || 'group_id'] = groupId;

  for (const col of cfg.intColumns) {
    const raw = (values[col] || '').trim();
    if (raw !== '') payload[col] = raw;
  }
  for (const col of cfg.textColumns) {
    const raw = (values[col] || '').trim();
    if (raw !== '') payload[col] = raw;
  }
  for (const col of cfg.boolColumns) {
    const raw = (values[col] || '').trim();
    if (raw !== '') payload[col] = coerceBool(raw);
  }
  Object.assign(payload, images || {});
  return payload;
}

const parseTags = (cell) => [...new Set(
  String(cell || '').split('|').map((t) => t.trim()).filter(Boolean),
)];

async function syncTags(row, tagNames, t) {
  const instances = [];
  for (const name of tagNames) {
    const [tag] = await models.Tag.findOrCreate({
      where: { name },
      defaults: { name, slug: slugify(name) || null },
      transaction: t,
    });
    instances.push(tag);
  }
  await row.setTags(instances, { transaction: t }); // full replace (blank cell => not called)
}

/**
 * Import one CSV file for an entity. Skip-bad-rows semantics: valid rows are
 * committed (each in its own transaction) and invalid rows are collected into a
 * per-row report. Parent/child categories are resolved across multiple passes so
 * an in-file parent can precede or follow its child. Image-key problems are
 * advisory only and surface as rows[].warnings.
 *
 * @returns {{ entity, dry_run, summary, notes, rows }}
 */
async function runImport(key, rawText, { dryRun = false, req } = {}) {
  const cfg = getEntity(key);
  const text = stripBom(String(rawText || ''));

  if (new RegExp(REFERENCE_SENTINEL, 'i').test(text)) {
    throw new ValidationError('This is the reference template. Download the import template and add your data before uploading.');
  }

  const { header, rows } = parse(text);
  if (!header.length) throw new ValidationError('The uploaded file is empty or has no header row.');

  const requiredCols = ['name', ...(cfg.groupColumn ? [cfg.groupColumn] : [])];
  const missing = requiredCols.filter((c) => !header.includes(c));
  if (missing.length) throw new ValidationError(`Missing required column(s): ${missing.join(', ')}`);

  // Pass 0: normalize + check every image cell up front, so the S3 HEADs run
  // once per distinct key with capped concurrency instead of row by row.
  const { byLine: imagesByLine, notes, missing: missingKeys } = await prepareImages(cfg, rows);
  const usedKeys = new Set();       // keys this run actually wrote to a record

  const model = cfg.model();
  const report = [];
  const summary = { total: rows.length, created: 0, updated: 0, skipped: 0, warnings: 0 };
  const resolvedByName = new Map(); // lowercased name OR slug -> id
  const skippedNames = new Set();   // lowercased names that failed (for cascade messaging)
  const groupCache = new Map();     // lowercased group name/slug -> id
  let dryCounter = 0;               // negative placeholder ids for dry-run creates

  const warn = (line, message) => {
    const entry = imagesByLine.get(line);
    if (entry) entry.warnings.push(message);
  };

  const record = (line, name, status, message) => {
    // Image warnings are attached whatever the row's outcome — an editor fixing a
    // skipped row wants to see its bad thumbnail in the same pass.
    const warnings = (imagesByLine.get(line) || {}).warnings || [];
    report.push({ line, name: name || null, status, message: message || null, warnings });
    summary[status] += 1;
    if (warnings.length) summary.warnings += 1;
    if (status === 'skipped' && name) skippedNames.add(name.trim().toLowerCase());
  };

  // Resolve a parent reference to an id: undefined => defer (not yet available).
  const resolveParent = async (ref) => {
    const lc = ref.toLowerCase();
    if (resolvedByName.has(lc)) return resolvedByName.get(lc);
    const found = await model.findOne({ where: { name: ref } })
      || await model.findOne({ where: { slug: ref } });
    if (found) { resolvedByName.set(lc, found.id); return found.id; }
    return undefined;
  };

  // Resolve (upserting if needed) a variant's brand series; throws if the cell is
  // blank. The series icon rides along on the row that first mentions the series;
  // an icon already on an existing series is left alone rather than overwritten,
  // since the series is a side effect of this import, not its subject.
  const resolveGroup = async (row, groupKey) => {
    const gname = (row.values[cfg.groupColumn] || '').trim();
    if (!gname) throw new Error(`${cfg.groupColumn} is required`);
    const glc = gname.toLowerCase();
    if (groupCache.has(glc)) return groupCache.get(glc);

    const iconField = cfg.groupS3Key ? cfg.groupS3Key.field : null;
    const GroupModel = cfg.groupModel();
    let group = await GroupModel.findOne({ where: { name: gname } })
      || await GroupModel.findOne({ where: { slug: gname } });
    let id;
    if (group) {
      id = group.id;
      if (iconField && groupKey) {
        if (group[iconField]) {
          warn(row.line, `${cfg.groupS3Key.column}: series '${gname}' already has an icon — left unchanged`);
        } else if (!dryRun) {
          await group.update({ [iconField]: groupKey });
          usedKeys.add(groupKey);
        }
      }
    } else if (dryRun) id = --dryCounter;
    else {
      group = await GroupModel.create({
        uid: uuid(), name: gname, slug: slugify(gname) || null,
        ...(iconField && groupKey ? { [iconField]: groupKey } : {}),
      });
      if (iconField && groupKey) usedKeys.add(groupKey);
      id = group.id;
    }
    groupCache.set(glc, id);
    return id;
  };

  const processRow = async (row, { parentId }) => {
    const values = row.values;
    const name = (values.name || '').trim();
    if (!name) { record(row.line, '', 'skipped', 'name is required'); return; }
    const lc = name.toLowerCase();

    const images = imagesByLine.get(row.line) || { values: {} };

    try {
      const groupId = cfg.groupModel ? await resolveGroup(row, images.groupKey) : undefined;

      // Does this record already exist (either processed earlier this run, or in the DB)?
      let existingRow = null;
      let existingId;
      if (resolvedByName.has(lc)) {
        existingId = resolvedByName.get(lc);
        if (!dryRun) existingRow = await model.findByPk(existingId);
      } else {
        existingRow = await model.findOne({ where: { name } });
        existingId = existingRow ? existingRow.id : undefined;
      }
      const isUpdate = existingId !== undefined;

      const payload = buildPayload(cfg, values, { parentId, groupId, images: images.values });
      const schema = isUpdate ? cfg.updateSchema : cfg.createSchema;
      const { error, value } = schema.validate(payload, { abortEarly: false });
      if (error) throw new Error(error.details.map((d) => d.message.replace(/["']/g, '')).join('; '));

      let id;
      let effectiveSlug = null;
      if (dryRun) {
        id = isUpdate ? existingId : --dryCounter;
        if (cfg.autoSlug) effectiveSlug = (values.slug || '').trim() || slugify(name) || null;
      } else {
        await sequelize.transaction(async (t) => {
          let inst;
          if (isUpdate) {
            inst = existingRow || await model.findOne({ where: { name }, transaction: t });
            await inst.update(value, { transaction: t });
          } else {
            const createPayload = { ...value };
            if (cfg.hasUid) createPayload.uid = uuid();
            if (cfg.autoSlug) createPayload.slug = (values.slug || '').trim() || slugify(name) || null;
            inst = await model.create(createPayload, { transaction: t });
          }
          if (cfg.tags && (values.tags || '').trim() !== '') {
            await syncTags(inst, parseTags(values.tags), t);
          }
          id = inst.id;
          effectiveSlug = inst.slug || null;
        });
        // Committed — these images are now referenced by a live record.
        for (const k of Object.values(images.values)) if (k) usedKeys.add(k);
      }

      resolvedByName.set(lc, id);
      if (effectiveSlug) resolvedByName.set(String(effectiveSlug).toLowerCase(), id);
      record(row.line, name, isUpdate ? 'updated' : 'created', dryRun ? 'dry run — not written' : null);
    } catch (err) {
      record(row.line, name, 'skipped', err.message);
    }
  };

  if (cfg.parentColumn) {
    // Multi-pass so an in-file parent can appear before or after its child.
    let pending = rows;
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      const next = [];
      for (const row of pending) {
        const parentRef = (row.values[cfg.parentColumn] || '').trim();
        let parentId = null;
        if (parentRef) {
          const resolved = await resolveParent(parentRef);
          if (resolved === undefined) { next.push(row); continue; } // defer
          parentId = resolved;
        }
        await processRow(row, { parentId });
        progress = true;
      }
      pending = next;
    }
    // Whatever remains has an unresolvable parent (missing, skipped, or cyclic).
    for (const row of pending) {
      const parentRef = (row.values[cfg.parentColumn] || '').trim();
      const reason = skippedNames.has(parentRef.toLowerCase())
        ? `parent '${parentRef}' was not imported (skipped above)`
        : `parent '${parentRef}' not found`;
      record(row.line, (row.values.name || '').trim(), 'skipped', reason);
    }
  } else {
    for (const row of rows) await processRow(row, {});
  }

  // Flip every image this run put into use to status=active, matching what
  // /admin/uploads/confirm does for panel uploads. Keys we already know are
  // absent are skipped — tagging them would only 404.
  if (!dryRun && usedKeys.size) {
    const toTag = [...usedKeys].filter((k) => !missingKeys.has(k));
    const failed = await tagActive(toTag);
    if (failed) notes.push(`${failed} of ${toTag.length} image(s) could not be tagged status=active in S3 — the records saved fine; re-run the import to retry.`);
  }

  if (!dryRun && (summary.created || summary.updated)) {
    await activity.log(req, { action: `import.${key}`, entityType: cfg.entityType, metadata: summary });
  }

  return { entity: key, dry_run: dryRun, summary, notes, rows: report };
}

const IMPORT_ENTITIES = [
  ...Object.entries(ENTITIES).map(([key, cfg]) => ({ key, permission: cfg.permission, deprecated: false })),
  ...Object.entries(ENTITY_ALIASES).map(([key, target]) => ({ key, permission: ENTITIES[target].permission, deprecated: true })),
];

module.exports = { runImport, buildTemplate, IMPORT_ENTITIES, ENTITY_ALIASES, ENTITY_KEYS: Object.keys(ENTITIES) };
