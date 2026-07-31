'use strict';

/**
 * Theme Group -> Brand Series, Theme -> Variant.
 *
 * A pure rename of the existing surface plus the new Brand Series / Variant fields,
 * done in ONE migration on purpose: splitting the rename from the schema additions
 * would leave an intermediate state where table names and column names disagree.
 *
 * What does NOT change: gating stays on the VARIANT. variant_plan_restrictions and
 * business_variants keep their exact semantics from 000006 / 000007 — only the table
 * and column names move. Industries likewise stay attached to the variant.
 *
 * What is new:
 *   brand_series  — icon_s3_key, caption (the sub-title), description
 *                 — style personalities (own taxonomy), tags (shared `tags` pool),
 *                   colors (shared taxonomy, ordered per series)
 *   variants      — badge_id, the single "Popular" / "Fresh" / "Dynamic" chip
 *
 * MySQL notes:
 *   - RENAME TABLE keeps InnoDB foreign keys pointing at the renamed table, so the
 *     FKs survive untouched. What it does NOT rename is index names, hence the
 *     explicit RENAME INDEX pass — otherwise `variants` would carry `uq_theme_name`
 *     forever, which is exactly the drift this rename is meant to remove.
 *   - ALTER TABLE ... CHANGE preserves the FK on a renamed column, so theme_id ->
 *     variant_id needs no drop/recreate dance.
 *   - RENAME INDEX requires MySQL 5.7+.
 */

// Tables, renamed oldest-first so later steps can address them by their NEW name.
const TABLES = [
  ['theme_groups',              'brand_series'],
  ['themes',                    'variants'],
  ['theme_templates',           'variant_templates'],
  ['theme_plan_restrictions',   'variant_plan_restrictions'],
  ['theme_business_categories', 'variant_industries'],
  ['business_themes',           'business_variants'],
];

// [table (new name), old column, new column, column definition]
const COLUMNS = [
  ['variants',                  'group_id', 'series_id',  'INT NOT NULL'],
  ['variant_templates',         'theme_id', 'variant_id', 'INT NOT NULL'],
  ['variant_plan_restrictions', 'theme_id', 'variant_id', 'INT NOT NULL'],
  ['variant_industries',        'theme_id', 'variant_id', 'INT NOT NULL'],
  ['business_variants',         'theme_id', 'variant_id', 'INT NOT NULL'],
];

// [table (new name), old index, new index]
//
// Runs AFTER the column rename, so entries here describe indexes over already-renamed
// columns. `group_id` is not a typo: InnoDB auto-creates an index named after the
// foreign-key column, and a column rename does not carry the index name with it.
const INDEXES = [
  ['brand_series',              'uq_theme_group_name',      'uq_brand_series_name'],
  ['brand_series',              'uq_theme_groups_slug',     'uq_brand_series_slug'],
  ['variants',                  'uq_theme_name',            'uq_variant_name'],
  ['variants',                  'group_id',                 'series_id'],
  ['variant_templates',         'uq_theme_template',        'uq_variant_template'],
  ['variant_plan_restrictions', 'uq_theme_plan',            'uq_variant_plan'],
  ['variant_industries',        'uq_theme_bizcat',          'uq_variant_industry'],
  ['business_variants',         'uq_business_theme',        'uq_business_variant'],
  ['business_variants',         'business_themes_theme_id', 'business_variants_variant_id'],
];

const flip = ([a, b]) => [b, a];

const scalar = async (qi, sql, replacements) => {
  const [rows] = await qi.sequelize.query(sql, { replacements });
  return Number(rows[0].n) > 0;
};

const tableExists = (qi, table) => scalar(
  qi,
  `SELECT COUNT(*) AS n FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = ?`,
  [table],
);

const columnExists = (qi, table, column) => scalar(
  qi,
  `SELECT COUNT(*) AS n FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
  [table, column],
);

const indexExists = (qi, table, name) => scalar(
  qi,
  `SELECT COUNT(*) AS n FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
  [table, name],
);

async function indexColumns(qi, table, name) {
  const [rows] = await qi.sequelize.query(
    `SELECT column_name AS col, non_unique AS nonuniq FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
      ORDER BY seq_in_index ASC`,
    { replacements: [table, name] },
  );
  if (!rows.length) return null;
  return { columns: rows.map((r) => r.col), unique: Number(rows[0].nonuniq) === 0 };
}

// MariaDB only learned ALTER TABLE ... RENAME INDEX in 10.5.2, and this deployment is
// older, so recreate instead. Order matters: CREATE the new index BEFORE dropping the
// old one. Several of these are the only index backing a foreign key, and dropping
// that first trips errno 1553 ("needed in a foreign key constraint").
//
// Skips quietly when the source index is absent — some names come from migrations a
// given database may never have run (e.g. an env restored from a pre-000008 dump) —
// and when the target already exists, which makes a half-applied run resumable.
async function renameIndex(qi, table, from, to) {
  if (await indexExists(qi, table, to)) return;
  const info = await indexColumns(qi, table, from);
  if (!info) return;
  const cols = info.columns.map((c) => `\`${c}\``).join(', ');
  await qi.sequelize.query(`CREATE ${info.unique ? 'UNIQUE ' : ''}INDEX \`${to}\` ON \`${table}\` (${cols})`);
  // Re-check: when the old index was InnoDB's auto-generated foreign-key index, creating
  // an equivalent one makes it redundant and InnoDB drops it for us (seen on MariaDB
  // 10.4 with `variants`.`group_id`). Dropping it again would then fail.
  if (await indexExists(qi, table, from)) {
    await qi.sequelize.query(`ALTER TABLE \`${table}\` DROP INDEX \`${from}\``);
  }
}

async function renameColumn(qi, table, from, to, definition) {
  if (!(await tableExists(qi, table)))       return;
  if (await columnExists(qi, table, to))     return;
  if (!(await columnExists(qi, table, from))) return;
  await qi.sequelize.query(`ALTER TABLE \`${table}\` CHANGE \`${from}\` \`${to}\` ${definition}`);
}

async function renameTable(qi, from, to) {
  if (await tableExists(qi, to)) return;
  if (!(await tableExists(qi, from))) return;
  await qi.sequelize.query(`RENAME TABLE \`${from}\` TO \`${to}\``);
}

// createTable already emits IF NOT EXISTS on MySQL/MariaDB; addColumn and addIndex do not.
async function addColumnIfMissing(qi, table, column, definition) {
  if (await columnExists(qi, table, column)) return;
  await qi.addColumn(table, column, definition);
}

async function addIndexIfMissing(qi, table, columns, options) {
  if (await indexExists(qi, table, options.name)) return;
  await qi.addIndex(table, columns, options);
}

// MySQL refuses to DROP a column that still backs a foreign key (errno 1828), and the
// constraint here is auto-named (variants_ibfk_N), so look it up rather than guess.
async function dropForeignKeys(qi, table, column) {
  const [rows] = await qi.sequelize.query(
    `SELECT constraint_name FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
        AND referenced_table_name IS NOT NULL`,
    { replacements: [table, column] },
  );
  for (const { constraint_name: name } of rows) {
    await qi.sequelize.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``);
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const S  = Sequelize;
    const pk = () => ({ type: S.INTEGER, primaryKey: true, autoIncrement: true });
    const uid = () => ({ type: S.UUID, allowNull: false, unique: true, defaultValue: S.UUIDV4 });
    const fk = (model, { allowNull = false, onDelete = 'CASCADE' } = {}) => ({
      type: S.INTEGER,
      allowNull,
      references: { model, key: 'id' },
      onDelete,
      onUpdate: 'CASCADE',
    });
    const bothTs = {
      created_at: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    };

    // ---- 1. rename tables ----
    for (const [from, to] of TABLES) {
      await renameTable(queryInterface, from, to);
    }

    // ---- 2. rename columns ----
    for (const [table, from, to, def] of COLUMNS) {
      await renameColumn(queryInterface, table, from, to, def);
    }

    // ---- 3. rename indexes ----
    for (const [table, from, to] of INDEXES) {
      await renameIndex(queryInterface, table, from, to);
    }

    // ---- 4. brand_series: card + detail-page copy ----
    // caption is the red sub-title ("Bright ideas deserve bright branding"), separate
    // from description, which is the paragraph under it.
    await addColumnIfMissing(queryInterface, 'brand_series', 'icon_s3_key', { type: S.STRING(500), allowNull: true });
    await addColumnIfMissing(queryInterface, 'brand_series', 'caption',     { type: S.STRING(255), allowNull: true });
    await addColumnIfMissing(queryInterface, 'brand_series', 'description', { type: S.TEXT,        allowNull: true });

    // ---- 5. style personalities (own taxonomy: "Bold • Premium • Confident") ----
    // Deliberately NOT the shared `tags` pool — a series carries both, and they are
    // rendered differently (personality is the strapline, tags are the pills).
    await queryInterface.createTable('style_personalities', {
      id:            pk(),
      uid:           uid(),
      name:          { type: S.STRING(100), allowNull: false },
      slug:          { type: S.STRING(120), allowNull: true },
      display_order: { type: S.INTEGER, defaultValue: 0 },
      is_active:     { type: S.TINYINT, defaultValue: 1 },
      ...bothTs,
    });
    await addIndexIfMissing(queryInterface, 'style_personalities', ['name'], { unique: true, name: 'uq_style_personality_name' });
    await addIndexIfMissing(queryInterface, 'style_personalities', ['slug'], { unique: true, name: 'uq_style_personality_slug' });

    await queryInterface.createTable('brand_series_style_personalities', {
      id:                    pk(),
      brand_series_id:       fk('brand_series'),
      style_personality_id:  fk('style_personalities'),
      display_order:         { type: S.INTEGER, defaultValue: 0 },
    });
    await addIndexIfMissing(queryInterface, 
      'brand_series_style_personalities',
      ['brand_series_id', 'style_personality_id'],
      { unique: true, name: 'uq_brand_series_style_personality' },
    );

    // ---- 6. brand series <-> tags (shared `tags` pool, same rows templates/assets use) ----
    await queryInterface.createTable('brand_series_tags', {
      id:              pk(),
      brand_series_id: fk('brand_series'),
      tag_id:          fk('tags'),
    });
    await addIndexIfMissing(queryInterface, 'brand_series_tags', ['brand_series_id', 'tag_id'], { unique: true, name: 'uq_brand_series_tag' });

    // ---- 7. colors (shared taxonomy so "Gold" is one hex everywhere) ----
    await queryInterface.createTable('colors', {
      id:            pk(),
      uid:           uid(),
      name:          { type: S.STRING(100), allowNull: false },
      slug:          { type: S.STRING(120), allowNull: true },
      hex_code:      { type: S.STRING(7), allowNull: false },   // #RRGGBB
      display_order: { type: S.INTEGER, defaultValue: 0 },
      is_active:     { type: S.TINYINT, defaultValue: 1 },
      ...bothTs,
    });
    await addIndexIfMissing(queryInterface, 'colors', ['name'], { unique: true, name: 'uq_color_name' });
    await addIndexIfMissing(queryInterface, 'colors', ['slug'], { unique: true, name: 'uq_color_slug' });

    // display_order carries the palette order shown on the card (Black, Charcoal, Gold).
    await queryInterface.createTable('brand_series_colors', {
      id:              pk(),
      brand_series_id: fk('brand_series'),
      color_id:        fk('colors'),
      display_order:   { type: S.INTEGER, defaultValue: 0 },
    });
    await addIndexIfMissing(queryInterface, 'brand_series_colors', ['brand_series_id', 'color_id'], { unique: true, name: 'uq_brand_series_color' });

    // ---- 8. variant badges ("Popular" / "Fresh" / "Dynamic", each with its own icon) ----
    // One badge per variant, so this is a nullable FK on variants rather than a join
    // table. SET NULL on delete: removing a badge must not delete the variants wearing it.
    await queryInterface.createTable('variant_badges', {
      id:            pk(),
      uid:           uid(),
      name:          { type: S.STRING(100), allowNull: false },
      slug:          { type: S.STRING(120), allowNull: true },
      icon_s3_key:   { type: S.STRING(500), allowNull: true },
      display_order: { type: S.INTEGER, defaultValue: 0 },
      is_active:     { type: S.TINYINT, defaultValue: 1 },
      ...bothTs,
    });
    await addIndexIfMissing(queryInterface, 'variant_badges', ['name'], { unique: true, name: 'uq_variant_badge_name' });
    await addIndexIfMissing(queryInterface, 'variant_badges', ['slug'], { unique: true, name: 'uq_variant_badge_slug' });

    await addColumnIfMissing(queryInterface, 'variants', 'badge_id', fk('variant_badges', { allowNull: true, onDelete: 'SET NULL' }));
  },

  async down(queryInterface) {
    await dropForeignKeys(queryInterface, 'variants', 'badge_id');
    await queryInterface.removeColumn('variants', 'badge_id');

    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['variant_badges', 'brand_series_colors', 'colors', 'brand_series_tags',
      'brand_series_style_personalities', 'style_personalities']) {
      await queryInterface.dropTable(t);
    }
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 1');

    await queryInterface.removeColumn('brand_series', 'description');
    await queryInterface.removeColumn('brand_series', 'caption');
    await queryInterface.removeColumn('brand_series', 'icon_s3_key');

    for (const [table, from, to] of INDEXES) {
      // `table` is the post-rename name, so undo the index rename BEFORE the table rename.
      await renameIndex(queryInterface, table, to, from);
    }
    for (const [table, from, to, def] of COLUMNS) {
      await renameColumn(queryInterface, table, to, from, def);
    }
    for (const [from, to] of TABLES.map(flip).reverse()) {
      await renameTable(queryInterface, from, to);
    }
  },
};
