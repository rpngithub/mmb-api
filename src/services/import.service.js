const { v4: uuid } = require('uuid');
const models    = require('../models');
const slugify   = require('../utils/slugify');
const { parse, stripBom, csvLine } = require('../utils/csv');
const activity  = require('./activity.service');
const { ValidationError } = require('../errors');
const {
  createBusinessCategorySchema, updateBusinessCategorySchema,
  createTemplateCategorySchema, updateTemplateCategorySchema,
} = require('../validators/category.validator');
const { createThemeSchema, updateThemeSchema } = require('../validators/theme.validator');

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
    columns: ['name', 'parent', 'slug', 'display_order', 'is_active', 'tags'],
    intColumns: ['display_order'],
    boolColumns: ['is_active'],
    textColumns: [],
    help: [
      '# Industries import. Lines starting with # are ignored.',
      '# name (required): unique across all industries. parent: name or slug of another industry (blank = top level).',
      '# slug: optional (auto-generated from name if blank). is_active: 1 or 0. tags: pipe-separated, e.g. food|dining|offers',
    ],
    example: [
      ['Restaurants', '', 'restaurants', '1', '1', 'food|dining|offers'],
      ['Fine Dining', 'Restaurants', 'fine-dining', '2', '1', 'premium|dining'],
      ['Retail', '', '', '3', '0', ''],
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
    columns: ['name', 'parent', 'slug', 'show_in_homepage', 'display_order', 'is_active'],
    intColumns: ['display_order'],
    boolColumns: ['show_in_homepage', 'is_active'],
    textColumns: [],
    help: [
      '# Template categories import. Lines starting with # are ignored.',
      '# name (required): unique across all template categories. parent: name/slug of another category (blank = top level).',
      '# slug: optional (auto from name). show_in_homepage / is_active: 1 or 0.',
    ],
    example: [
      ['Festivals', '', 'festivals', '1', '1', '1'],
      ['Diwali Greetings', 'Festivals', 'diwali-greetings', '0', '2', '1'],
    ],
  },

  themes: {
    label: 'Themes',
    entityType: 'theme',
    permission: 'themes',
    model: () => models.Theme,
    createSchema: createThemeSchema,
    updateSchema: updateThemeSchema,
    hasUid: true,
    autoSlug: false,
    groupColumn: 'group',
    groupModel: () => models.ThemeGroup,
    tags: false,
    columns: ['group', 'name', 'description', 'display_order', 'is_active'],
    intColumns: ['display_order'],
    boolColumns: ['is_active'],
    textColumns: ['description'],
    help: [
      '# Themes import. Lines starting with # are ignored.',
      '# group (required): theme-group name or slug — created automatically if it does not exist.',
      '# name (required): unique across all themes. is_active: 1 or 0.',
    ],
    example: [
      ['Minimal', 'Clean Slate', 'A minimal light theme', '1', '1'],
      ['Minimal', 'Bold Dark', 'High-contrast dark theme', '2', '1'],
    ],
  },
};

const REFERENCE_SENTINEL = 'REFERENCE-ONLY';

function getEntity(key) {
  const cfg = ENTITIES[key];
  if (!cfg) throw new ValidationError(`Unknown import entity: ${key}`);
  return cfg;
}

// ---- Template download (import + reference variants), built from `columns`. ----
function buildTemplate(key, { example = false } = {}) {
  const cfg = getEntity(key);
  const header = csvLine(cfg.columns);
  const lines = [];

  if (example) {
    lines.push(`# ${cfg.label} — ${REFERENCE_SENTINEL} — DO NOT IMPORT.`);
    lines.push('# For understanding the format only. Download the import template to add your data.');
    lines.push(...cfg.help.slice(1));
    lines.push(header);
    // Example data rows are #-commented so this file imports nothing even if uploaded.
    for (const row of cfg.example) lines.push(`# ${csvLine(row)}`);
  } else {
    lines.push(...cfg.help);
    lines.push(header);
  }

  const filename = example ? `${key}_EXAMPLE_do-not-import.csv` : `${key}_import_template.csv`;
  return { filename, content: `${lines.join('\r\n')}\r\n` };
}

// Build the Joi-validatable payload from a row's cells (schema fields only; slug,
// tags and the parent/group meta columns are handled separately).
function buildPayload(cfg, values, { parentId, groupId }) {
  const payload = { name: (values.name || '').trim() };
  if (cfg.parentColumn && parentId != null) payload.parent_id = parentId;
  if (cfg.groupModel) payload.group_id = groupId;

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
 * an in-file parent can precede or follow its child.
 *
 * @returns {{ entity, dry_run, summary, rows }}
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

  const model = cfg.model();
  const report = [];
  const summary = { total: rows.length, created: 0, updated: 0, skipped: 0 };
  const resolvedByName = new Map(); // lowercased name OR slug -> id
  const skippedNames = new Set();   // lowercased names that failed (for cascade messaging)
  const groupCache = new Map();     // lowercased group name/slug -> id
  let dryCounter = 0;               // negative placeholder ids for dry-run creates

  const record = (line, name, status, message) => {
    report.push({ line, name: name || null, status, message: message || null });
    summary[status] += 1;
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

  // Resolve (upserting if needed) a theme's group; throws if the cell is blank.
  const resolveGroup = async (values) => {
    const gname = (values[cfg.groupColumn] || '').trim();
    if (!gname) throw new Error('group is required');
    const glc = gname.toLowerCase();
    if (groupCache.has(glc)) return groupCache.get(glc);

    const GroupModel = cfg.groupModel();
    let group = await GroupModel.findOne({ where: { name: gname } })
      || await GroupModel.findOne({ where: { slug: gname } });
    let id;
    if (group) id = group.id;
    else if (dryRun) id = --dryCounter;
    else {
      group = await GroupModel.create({ uid: uuid(), name: gname, slug: slugify(gname) || null });
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

    try {
      const groupId = cfg.groupModel ? await resolveGroup(values) : undefined;

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

      const payload = buildPayload(cfg, values, { parentId, groupId });
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

  if (!dryRun && (summary.created || summary.updated)) {
    await activity.log(req, { action: `import.${key}`, entityType: cfg.entityType, metadata: summary });
  }

  return { entity: key, dry_run: dryRun, summary, rows: report };
}

const IMPORT_ENTITIES = Object.entries(ENTITIES).map(([key, cfg]) => ({ key, permission: cfg.permission }));

module.exports = { runImport, buildTemplate, IMPORT_ENTITIES, ENTITY_KEYS: Object.keys(ENTITIES) };
