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
const {
  createAssetSchema, updateAssetSchema,
  createAssetCategorySchema, updateAssetCategorySchema,
} = require('../validators/asset.validator');
const { ASSET_TYPES } = require('../utils/assetTypes');

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

// `status` is an enum, not a flag, but an admin filling a sheet reaches for the
// 1/0 they type in every other template — accept both spellings.
const coerceStatus = (v) => {
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'active'].includes(s)) return 'active';
  if (['0', 'false', 'no', 'n', 'inactive'].includes(s)) return 'inactive';
  return v;
};

// ---- File (S3 key) columns. Editors upload the file to S3 themselves and paste
//      the key here; the importer never moves bytes. Every file check is
//      ADVISORY — a bad key is reported as a row warning and still imported, so a
//      typo never costs an editor the rest of the row. `NONE` clears the file,
//      blank leaves whatever is already stored.
//
//      One exception: a column marked `required` (an asset IS its file — there is
//      no record to import without one) skips the row when the cell is blank. ----
const CLEAR_IMAGE = 'NONE';
const S3_CONCURRENCY = 15;

// What a key is expected to point at. Drives the extension, content-type and size
// warnings only; nothing here can stop a row importing.
const FILE_KINDS = {
  image:    { label: 'an image',     exts: ['png', 'jpg', 'jpeg', 'webp', 'svg'], ct: /^image\//i, max: 5 * 1024 * 1024 },
  audio:    { label: 'an audio',     exts: ['mp3', 'wav', 'm4a', 'aac', 'ogg'],   ct: /^audio\//i, max: 20 * 1024 * 1024 },
  video:    { label: 'a video',      exts: ['mp4', 'webm', 'mov'],                ct: /^video\//i, max: 50 * 1024 * 1024 },
  // A Lottie animation is a .json, so this kind has to accept application/* next
  // to the image/* and video/* of gif, webp and mp4.
  animated: { label: 'an animation', exts: ['json', 'gif', 'webp', 'mp4'],        ct: /^(image|video|application)\//i, max: 10 * 1024 * 1024 },
};

// assets.asset_type -> the kind of file that row's key should point at.
const ASSET_FILE_KIND = {
  icon: 'image', emoji: 'image', shape: 'image', bg: 'image',
  audio: 'audio', video: 'video', animated: 'animated',
};

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

  'asset-categories': {
    label: 'Asset categories',
    entityType: 'asset_category',
    permission: 'assets',
    model: () => models.AssetCategory,
    createSchema: createAssetCategorySchema,
    updateSchema: updateAssetCategorySchema,
    hasUid: true,
    autoSlug: true,
    parentColumn: 'parent',
    tags: false,
    columns: ['name', 'parent', 'slug', 'display_order', 'is_active'],
    intColumns: ['display_order'],
    boolColumns: ['is_active'],
    textColumns: [],
    help: [
      '# Asset categories import. Lines starting with # are ignored.',
      '# Import this file BEFORE the assets that live in these categories.',
      '# name (required): an existing category with the same name is updated. parent: name or slug of another asset category (blank = top level).',
      '# slug: optional (auto from name) but must be unique across all asset categories. is_active: 1 or 0.',
    ],
    example: [
      ['Festive Icons', '', 'festive-icons', '1', '1'],
      ['Diwali', 'Festive Icons', 'diwali-icons', '2', '1'],
      ['Backgrounds', '', '', '3', '1'],
    ],
  },

  assets: {
    label: 'Assets',
    entityType: 'asset',
    permission: 'assets',
    model: () => models.Asset,
    createSchema: createAssetSchema,
    updateSchema: updateAssetSchema,
    hasUid: true,
    autoSlug: false,
    // Asset NAMES repeat legitimately (a 'Star' icon per category), so the file is
    // the identity: one S3 object = one asset. Re-importing a key updates that
    // asset in place, which is what makes a corrected sheet safe to re-upload.
    keyColumn: 's3_key',
    requiredColumns: ['asset_type'],
    tags: true,
    // Lookup-only, unlike a variant's brand series: a mistyped category must not
    // quietly invent a browse category, and an asset with no category is invisible
    // in the app (the public asset list is category-anchored).
    refColumns: [
      {
        column: 'category', field: 'category_id', model: () => models.AssetCategory,
        required: true, label: 'asset category',
        hint: 'create it in Asset Categories, or import asset-categories before this file',
      },
    ],
    columns: ['category', 'name', 'asset_type', 's3_key', 'is_premium', 'status', 'tags'],
    intColumns: [],
    boolColumns: ['is_premium'],
    textColumns: ['asset_type'],
    statusColumns: ['status'],
    fileNoun: 'Files',
    s3KeyColumns: {
      s3_key: {
        required: true,
        key: true,
        // Mirrors the `asset` target of upload.service.buildKey.
        prefix: (v) => `assets/${String(v.asset_type || '').trim().toLowerCase()}/`,
        kind:   (v) => ASSET_FILE_KIND[String(v.asset_type || '').trim().toLowerCase()],
        help: 'assets/<asset_type>/',
        helpExts: '<ext>',
      },
    },
    help: [
      '# Assets import. Lines starting with # are ignored.',
      '# category (required): name, slug or uid of an EXISTING asset category — import asset-categories first if it is new.',
      '# name (required): the label shown in the editor. Names need not be unique.',
      `# asset_type (required): one of ${ASSET_TYPES.join(', ')}.`,
      '# s3_key (required): rows are matched on it — re-importing the same key UPDATES that asset instead of adding a second one.',
      '#   File by asset_type: icon/emoji/shape/bg -> png, jpg, webp, svg · audio -> mp3, wav, m4a · video -> mp4, webm · animated -> json (Lottie), gif, webp, mp4',
      '# is_premium: 1 or 0 (1 = paid plans only). status: active or inactive (1/0 accepted). tags: pipe-separated, e.g. diwali|festival|lamp',
    ],
    example: [
      ['Festive Icons', 'Diya', 'icon', 'assets/icon/diya.svg', '0', 'active', 'diwali|festival'],
      ['Festive Icons', 'Firecracker', 'icon', 'assets/icon/firecracker.svg', '1', 'active', 'diwali'],
      ['Backgrounds', 'Gold Bokeh', 'bg', 'assets/bg/gold-bokeh.jpg', '1', 'active', 'festive|gold'],
      ['Sound Effects', 'Chime', 'audio', 'assets/audio/chime.mp3', '0', 'inactive', ''],
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

// ---- File columns -----------------------------------------------------------

// Normalize one `s3KeyColumns` entry. A column is declared either as a plain
// prefix (string or list) or as an object; `prefix` and `kind` may be functions of
// the row's cells, because an asset's expected location and file type both follow
// its asset_type column. `helpPrefix`/`helpExts` are the static text used by the
// downloadable template, where there is no row to read.
function fileSpec(column, def, scope) {
  const o = (def && typeof def === 'object' && !Array.isArray(def)) ? def : { prefix: def };
  const at = (v, values) => (typeof v === 'function' ? v(values) : v);
  return {
    column,
    scope,
    required: Boolean(o.required),
    isKey:    Boolean(o.key),
    prefixes: (values) => [].concat(at(o.prefix, values)).filter(Boolean),
    kind:     (values) => FILE_KINDS[at(o.kind, values)] || FILE_KINDS.image,
    helpPrefix: o.help || [].concat(at(o.prefix, {})).filter(Boolean)[0] || '',
    helpExts:   o.helpExts || null,
  };
}

// Flatten an entity's file columns into one spec list. `scope` separates the
// row's own files from a file that belongs to the upserted group (a variant
// row carrying its brand series' icon).
const fileSpecs = (cfg) => [
  ...Object.entries(cfg.s3KeyColumns || {}).map(([column, def]) => fileSpec(column, def, 'row')),
  ...(cfg.groupS3Key ? [fileSpec(cfg.groupS3Key.column, cfg.groupS3Key.prefix, 'group')] : []),
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
function shapeWarnings(spec, key, values) {
  const w = [];
  const prefixes = spec.prefixes(values);
  const kind = spec.kind(values);
  if (prefixes.length && !prefixes.some((p) => key.startsWith(p))) {
    w.push(`${spec.column}: expected a key under '${prefixes[0]}' — imported as given, check the upload location`);
  }
  if (/\s/.test(key)) w.push(`${spec.column}: key contains a space`);
  if (key.includes('..')) w.push(`${spec.column}: key contains '..'`);
  const m = /\.([A-Za-z0-9]+)$/.exec(key);
  const e = m ? m[1].toLowerCase() : '';
  if (!kind.exts.includes(e)) {
    w.push(`${spec.column}: '${e || 'no file extension'}' is not ${kind.label} type (${kind.exts.join(', ')})`);
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
 * Pass 0 over the parsed rows: normalize every file cell, collect advisory
 * warnings (shape, prefix, duplicate reuse, missing/oversized object) and hand
 * back the cleaned values keyed by source line. `errors` holds the one
 * non-advisory case — a required file column left blank — which skips the row.
 *
 * @returns {{ byLine: Map<number, { values, kinds, groupKey, warnings, errors }>, notes: string[], missing: Set<string> }}
 */
async function prepareFiles(cfg, rows) {
  const specs = fileSpecs(cfg);
  const byLine = new Map();
  const notes = [];
  const missing = new Set();   // probed and confirmed absent — never worth tagging later
  if (!specs.length) return { byLine, notes, missing };

  const firstSeen = new Map(); // key -> source line that used it first
  const distinct = new Set();

  for (const row of rows) {
    const entry = { values: {}, kinds: {}, groupKey: undefined, warnings: [], errors: [] };
    byLine.set(row.line, entry);

    for (const spec of specs) {
      const cell = String(row.values[spec.column] == null ? '' : row.values[spec.column]).trim();
      const key = cell && cell.toUpperCase() !== CLEAR_IMAGE ? normalizeS3Key(cell) : '';
      if (!key) {
        if (spec.required) { entry.errors.push(`${spec.column} is required`); continue; }
        if (!cell) continue;                                // blank -> leave as-is
        if (cell.toUpperCase() === CLEAR_IMAGE && spec.scope === 'row') entry.values[spec.column] = null;
        continue;
      }

      if (spec.scope === 'row') entry.values[spec.column] = key;
      else entry.groupKey = key;
      entry.kinds[spec.column] = spec.kind(row.values);

      entry.warnings.push(...shapeWarnings(spec, key, row.values));

      // Group files legitimately repeat across a series' rows; only flag reuse
      // of a row-scoped file, which is nearly always a copy-paste slip. When the
      // file IS the row's identity, reuse is not a slip but a second edit of the
      // same record, so say that instead.
      if (spec.scope === 'row') {
        if (firstSeen.has(key)) {
          const at = firstSeen.get(key);
          if (spec.isKey) entry.warnings.push(`${spec.column}: same file as line ${at} — that record is updated, not duplicated`);
          else entry.warnings.push(at === row.line
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
      const kind = entry.kinds[column] || FILE_KINDS.image;
      if (probe.content_type && !kind.ct.test(probe.content_type)) {
        entry.warnings.push(`${column}: object is '${probe.content_type}', not ${kind.label}`);
      }
      if (probe.size != null && probe.size > kind.max) {
        entry.warnings.push(`${column}: object is ${Math.round(probe.size / 1024)} KB (over ${kind.max / 1024 / 1024} MB)`);
      }
    }
  }

  return { byLine, notes, missing };
}

// ---- Template download (import + reference variants), built from `columns`. ----

// File rules are generated from the entity's own spec so the help can never
// drift from what the importer actually accepts.
function fileHelp(cfg) {
  const specs = fileSpecs(cfg);
  if (!specs.length) return [];
  const noun = cfg.fileNoun || 'Images';
  const lines = [`# ${noun}: upload the file to S3 first, then paste its KEY here (a full https:// URL is accepted and trimmed to the key).`];
  for (const spec of specs) {
    const note = spec.scope === 'group' ? '   (only applied when the series has no icon yet)' : '';
    const exts = spec.helpExts || spec.kind({}).exts.join('|');
    lines.push(`#   ${spec.column} -> ${spec.helpPrefix}<filename>.${exts}${note}`);
  }
  const one = cfg.fileNoun ? 'file' : 'image';
  const optional = specs.filter((s) => !s.required);
  if (optional.length) lines.push(`#   Blank = keep the current ${one}. ${CLEAR_IMAGE} = remove the current ${one}.`);
  const required = specs.filter((s) => s.required).map((s) => s.column);
  if (required.length) lines.push(`#   ${required.join(', ')} cannot be blank — a row without it is skipped.`);
  lines.push('#   Other key problems never skip a row: the row imports and the issue is listed under rows[].warnings in the response.');
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
    lines.push(...cfg.help.slice(1), ...fileHelp(cfg));
    lines.push(header);
    // Example data rows are #-commented so this file imports nothing even if uploaded.
    for (const row of cfg.example) lines.push(`# ${csvLine(row)}`);
  } else {
    lines.push(...cfg.help, ...fileHelp(cfg));
    lines.push(header);
  }

  const filename = example ? `${key}_EXAMPLE_do-not-import.csv` : `${key}_import_template.csv`;
  return { filename, content: `${lines.join('\r\n')}\r\n` };
}

// Build the Joi-validatable payload from a row's cells (schema fields only; slug,
// tags and the parent/group/ref meta columns are handled separately). `files`
// holds the already-normalized S3 keys for this row (null = clear, absent =
// unchanged) and `refs` the ids resolved from lookup columns.
function buildPayload(cfg, values, { parentId, groupId, files, refs }) {
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
  for (const col of cfg.statusColumns || []) {
    const raw = (values[col] || '').trim();
    if (raw !== '') payload[col] = coerceStatus(raw);
  }
  Object.assign(payload, refs || {}, files || {});
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
 * an in-file parent can precede or follow its child. File-key problems are
 * advisory only and surface as rows[].warnings, except for a required key column.
 *
 * @returns {{ entity, dry_run, summary, notes, rows }}
 */
async function runImport(key, rawText, { dryRun = false, req } = {}) {
  const cfg = getEntity(key);
  const keyColumn = cfg.keyColumn || 'name';
  const text = stripBom(String(rawText || ''));

  if (new RegExp(REFERENCE_SENTINEL, 'i').test(text)) {
    throw new ValidationError('This is the reference template. Download the import template and add your data before uploading.');
  }

  const { header, rows } = parse(text);
  if (!header.length) throw new ValidationError('The uploaded file is empty or has no header row.');

  const refColumns = cfg.refColumns || [];
  const requiredCols = [...new Set([
    'name', keyColumn,
    ...(cfg.groupColumn ? [cfg.groupColumn] : []),
    ...(cfg.requiredColumns || []),
    ...refColumns.filter((r) => r.required).map((r) => r.column),
  ])];
  const missing = requiredCols.filter((c) => !header.includes(c));
  if (missing.length) throw new ValidationError(`Missing required column(s): ${missing.join(', ')}`);

  // Pass 0: normalize + check every file cell up front, so the S3 HEADs run
  // once per distinct key with capped concurrency instead of row by row.
  const { byLine: filesByLine, notes, missing: missingKeys } = await prepareFiles(cfg, rows);
  const usedKeys = new Set();       // keys this run actually wrote to a record

  const model = cfg.model();
  const report = [];
  const summary = { total: rows.length, created: 0, updated: 0, skipped: 0, warnings: 0 };
  // Identity of a record already handled this run: lowercased name (or slug) for
  // name-keyed entities, the normalized S3 key for assets.
  const resolvedByName = new Map();
  const skippedNames = new Set();   // lowercased names that failed (for cascade messaging)
  const groupCache = new Map();     // lowercased group name/slug -> id
  const refCache = new Map();       // 'column:ref' -> id | null (not found)
  let dryCounter = 0;               // negative placeholder ids for dry-run creates

  const warn = (line, message) => {
    const entry = filesByLine.get(line);
    if (entry) entry.warnings.push(message);
  };

  const record = (line, name, status, message) => {
    // File warnings are attached whatever the row's outcome — an editor fixing a
    // skipped row wants to see its bad thumbnail in the same pass.
    const warnings = (filesByLine.get(line) || {}).warnings || [];
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

  // Resolve a lookup-only reference (an asset's category) by slug, uid or name.
  // Nothing is created: an unknown value skips the row, so a typo cannot invent a
  // browse category. Ambiguity is reported rather than silently resolved.
  const resolveRefColumn = async (spec, ref) => {
    const cacheKey = `${spec.column}:${ref.toLowerCase()}`;
    if (refCache.has(cacheKey)) return refCache.get(cacheKey);

    const RefModel = spec.model();
    const attrs = RefModel.rawAttributes;
    let id = null;
    const bySlug = attrs.slug ? await RefModel.findOne({ where: { slug: ref } }) : null;
    const byUid = !bySlug && attrs.uid && /^[0-9a-f-]{36}$/i.test(ref)
      ? await RefModel.findOne({ where: { uid: ref } })
      : null;
    if (bySlug || byUid) id = (bySlug || byUid).id;
    else {
      const byName = await RefModel.findAll({ where: { name: ref }, limit: 2 });
      if (byName.length > 1) {
        throw new Error(`${spec.column} '${ref}' matches more than one ${spec.label || spec.column} — use its slug instead`);
      }
      if (byName.length) id = byName[0].id;
    }
    refCache.set(cacheKey, id);
    return id;
  };

  const resolveRefs = async (values) => {
    const out = {};
    for (const spec of refColumns) {
      const ref = (values[spec.column] || '').trim();
      if (!ref) {
        if (spec.required) throw new Error(`${spec.column} is required`);
        continue;
      }
      const id = await resolveRefColumn(spec, ref);
      if (id === null) throw new Error(`${spec.column} '${ref}' not found${spec.hint ? ` — ${spec.hint}` : ''}`);
      out[spec.field] = id;
    }
    return out;
  };

  const processRow = async (row, { parentId }) => {
    const values = row.values;
    const name = (values.name || '').trim();
    if (!name) { record(row.line, '', 'skipped', 'name is required'); return; }
    const lc = name.toLowerCase();

    const files = filesByLine.get(row.line) || { values: {}, errors: [] };

    try {
      // A required file column with nothing usable in it (blank, or NONE) — the
      // only file problem that stops a row.
      if (files.errors && files.errors.length) throw new Error(files.errors.join('; '));

      const groupId = cfg.groupModel ? await resolveGroup(row, files.groupKey) : undefined;
      const refs = await resolveRefs(values);

      // The value this row is matched on: the record's name, or for assets the
      // normalized S3 key (which prepareFiles has already trimmed out of any URL).
      const keyValue = keyColumn === 'name' ? name
        : (files.values[keyColumn] || (values[keyColumn] || '').trim());
      if (!keyValue) throw new Error(`${keyColumn} is required`);
      // S3 keys are case-sensitive; names are matched case-insensitively.
      const identity = keyColumn === 'name' ? lc : keyValue;

      // Does this record already exist (either processed earlier this run, or in the DB)?
      let existingRow = null;
      let existingId;
      if (resolvedByName.has(identity)) {
        existingId = resolvedByName.get(identity);
        if (!dryRun) existingRow = await model.findByPk(existingId);
      } else {
        existingRow = await model.findOne({ where: { [keyColumn]: keyValue } });
        existingId = existingRow ? existingRow.id : undefined;
      }
      const isUpdate = existingId !== undefined;

      const payload = buildPayload(cfg, values, { parentId, groupId, files: files.values, refs });
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
            inst = existingRow || await model.findOne({ where: { [keyColumn]: keyValue }, transaction: t });
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
        // Committed — these files are now referenced by a live record.
        for (const k of Object.values(files.values)) if (k) usedKeys.add(k);
      }

      resolvedByName.set(identity, id);
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
