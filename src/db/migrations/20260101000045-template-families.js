'use strict';

/**
 * Template families: one design, many versions.
 *
 * The content team uploads one design several times — once per size, once per
 * language — and nothing tied those rows together, so the feed showed the same
 * design as several cards. Now:
 *
 *   template_families  the design. Owns everything the versions share: name
 *                      (unique — moved here from templates), category, industries,
 *                      tags, special events, variant membership, template_type,
 *                      is_premium, is_popular, status and the counters/trending.
 *   templates          one VERSION of a family: language (NULL = text-free), ONE
 *                      size, the design JSON, thumbnail and its own status.
 *                      Unique per (family, language, size).
 *
 * Existing data: every template becomes a family of ONE, with family.id =
 * template.id. That identity is what lets the four join tables (tags, industries,
 * variants, special events) keep every row — only their column is renamed
 * template_id -> family_id and the FK retargeted. Projects keep pointing at the
 * template (version) row, which still exists under the same id and uid.
 *
 * Sizes: template_size_map let one row claim several sizes while holding one JSON.
 * A version has exactly one size, so the row keeps the default size (1080×1350)
 * when it is mapped, else its lowest size id, and every OTHER mapped size becomes a
 * cloned version carrying the same JSON and thumbnail keys. That is exactly what
 * the API served before, so nothing changes for users — but each clone is logged,
 * because an admin should upload the real layout for that size.
 *
 * MariaDB 10.4 (the deployment) cannot run DDL inside a transaction, so every step
 * checks whether it already ran; a half-applied run can simply be run again.
 */

const DEFAULT_SIZE = { width: 1080, height: 1350 };

// Columns that move from templates to template_families.
const MOVED = ['category_id', 'template_type', 'is_premium', 'is_popular',
  'trending_score', 'views_count', 'downloads_count', 'likes_count'];

// Join tables whose template_id becomes family_id.
const JOIN_TABLES = ['template_tags', 'template_business_categories', 'variant_templates', 'special_event_templates'];

const query = (qi, sql, replacements) => qi.sequelize.query(sql, { replacements }).then(([rows]) => rows);

const scalar = async (qi, sql, replacements) => Number((await query(qi, sql, replacements))[0].n) > 0;

const tableExists = (qi, table) => scalar(qi,
  `SELECT COUNT(*) AS n FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = ?`, [table]);

const columnExists = (qi, table, column) => scalar(qi,
  `SELECT COUNT(*) AS n FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);

const indexExists = (qi, table, name) => scalar(qi,
  `SELECT COUNT(*) AS n FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, name]);

// FK constraint names are generated (`<table>_ibfk_N`) and differ between databases,
// so look them up rather than hardcoding.
async function foreignKeysOn(qi, table, column) {
  const rows = await query(qi,
    `SELECT constraint_name AS name, referenced_table_name AS ref FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? AND referenced_table_name IS NOT NULL`,
    [table, column]);
  return rows;
}

async function dropForeignKeys(qi, table, column) {
  for (const fk of await foreignKeysOn(qi, table, column)) {
    await qi.sequelize.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${fk.name}\``);
  }
}

async function addForeignKey(qi, table, column, refTable, name, onDelete = 'CASCADE') {
  const existing = await foreignKeysOn(qi, table, column);
  if (existing.some((fk) => fk.ref === refTable)) return;
  await qi.sequelize.query(
    `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${name}\` FOREIGN KEY (\`${column}\`)
       REFERENCES \`${refTable}\` (\`id\`) ON DELETE ${onDelete} ON UPDATE CASCADE`);
}

async function defaultSizeId(qi) {
  const rows = await query(qi,
    'SELECT id FROM template_sizes WHERE width = ? AND height = ? ORDER BY id ASC LIMIT 1',
    [DEFAULT_SIZE.width, DEFAULT_SIZE.height]);
  return rows.length ? rows[0].id : null;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi  = queryInterface;
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');

    // 1. The family table.
    await qi.createTable('template_families', {
      id:              { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid:             { type: S.UUID, allowNull: false, unique: true },
      name:            { type: S.STRING(200), allowNull: false },
      category_id:     { type: S.INTEGER, allowNull: true, references: { model: 'template_categories', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      template_type:   { type: S.ENUM('image', 'video', 'animated'), allowNull: false, defaultValue: 'image' },
      is_premium:      { type: S.TINYINT, allowNull: false, defaultValue: 0 },
      is_popular:      { type: S.TINYINT, allowNull: false, defaultValue: 0 },
      trending_score:  { type: S.FLOAT, allowNull: false, defaultValue: 0 },
      views_count:     { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      downloads_count: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      likes_count:     { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      status:          { type: S.ENUM('active', 'inactive', 'draft'), allowNull: false, defaultValue: 'draft' },
      created_by:      { type: S.INTEGER, allowNull: true, references: { model: 'admin_users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      created_at:      { type: S.DATE, allowNull: false, defaultValue: now },
      updated_at:      { type: S.DATE, allowNull: false, defaultValue: now },
    });
    if (!(await indexExists(qi, 'template_families', 'uq_template_family_name'))) {
      await qi.addIndex('template_families', ['name'], { unique: true, name: 'uq_template_family_name' });
    }
    if (!(await indexExists(qi, 'template_families', 'idx_template_family_status_trending'))) {
      await qi.addIndex('template_families', ['status', 'trending_score'], { name: 'idx_template_family_status_trending' });
    }

    // 2. One family per existing template, same id. Only while the moved columns are
    //    still on templates (a re-run after step 7 has nothing to copy).
    if (await columnExists(qi, 'templates', 'category_id')) {
      await qi.sequelize.query(
        `INSERT IGNORE INTO template_families
           (id, uid, name, category_id, template_type, is_premium, is_popular, trending_score,
            views_count, downloads_count, likes_count, status, created_by, created_at, updated_at)
         SELECT id, UUID(), name, category_id, COALESCE(template_type, 'image'), COALESCE(is_premium, 0),
                COALESCE(is_popular, 0), COALESCE(trending_score, 0), COALESCE(views_count, 0),
                COALESCE(downloads_count, 0), COALESCE(likes_count, 0), COALESCE(status, 'draft'),
                created_by, created_at, updated_at
           FROM templates`);
    }

    // Version names are labels now; uniqueness lives on the family. Dropped before
    // the size split because clones share their original's name.
    if (await indexExists(qi, 'templates', 'uq_template_name')) {
      await qi.removeIndex('templates', 'uq_template_name');
    }

    // 3. templates.family_id + templates.size_id.
    if (!(await columnExists(qi, 'templates', 'family_id'))) {
      await qi.addColumn('templates', 'family_id', { type: S.INTEGER, allowNull: true, after: 'uid' });
    }
    await qi.sequelize.query('UPDATE templates SET family_id = id WHERE family_id IS NULL');
    await qi.sequelize.query('ALTER TABLE `templates` MODIFY `family_id` INT NOT NULL');
    await addForeignKey(qi, 'templates', 'family_id', 'template_families', 'fk_templates_family');

    if (!(await columnExists(qi, 'templates', 'size_id'))) {
      await qi.addColumn('templates', 'size_id', { type: S.INTEGER, allowNull: true, after: 'language_id' });
    }
    await addForeignKey(qi, 'templates', 'size_id', 'template_sizes', 'fk_templates_size', 'SET NULL');

    // 4. Split multi-size rows. Idempotent: the original's size_id is set BEFORE its
    //    clones are inserted, and each clone is inserted only if its slot is empty.
    if (await tableExists(qi, 'template_size_map')) {
      const preferred = await defaultSizeId(qi);
      const maps = await query(qi,
        `SELECT m.template_id, m.size_id, s.name AS size_name
           FROM template_size_map m JOIN template_sizes s ON s.id = m.size_id
          ORDER BY m.template_id ASC, m.size_id ASC`);

      const byTemplate = new Map();
      for (const m of maps) {
        if (!byTemplate.has(m.template_id)) byTemplate.set(m.template_id, []);
        byTemplate.get(m.template_id).push(m);
      }

      let cloned = 0;
      for (const [templateId, sizes] of byTemplate) {
        const [tpl] = await query(qi, 'SELECT id, uid, name, size_id FROM templates WHERE id = ?', [templateId]);
        if (!tpl) continue;

        const keep = tpl.size_id
          || (sizes.find((s) => s.size_id === preferred) || sizes[0]).size_id;
        if (!tpl.size_id) await qi.sequelize.query('UPDATE templates SET size_id = ? WHERE id = ?', { replacements: [keep, templateId] });

        for (const extra of sizes.filter((s) => s.size_id !== keep)) {
          // Skip a slot a previous (interrupted) run already filled.
          const exists = await scalar(qi,
            `SELECT COUNT(*) AS n FROM templates o JOIN templates t ON t.id = ?
              WHERE o.family_id = t.family_id AND o.size_id = ? AND o.language_id <=> t.language_id`,
            [templateId, extra.size_id]);
          if (exists) continue;

          await qi.sequelize.query(
            `INSERT INTO templates (uid, family_id, language_id, size_id, name, thumbnail_s3_key, content, status, created_by, created_at, updated_at)
             SELECT UUID(), t.family_id, t.language_id, ?, t.name, t.thumbnail_s3_key, t.content, t.status, t.created_by, t.created_at, NOW()
               FROM templates t WHERE t.id = ?`,
            { replacements: [extra.size_id, templateId] });
          cloned += 1;
          console.log(`[migration 045] template ${tpl.uid} ("${tpl.name}") also claimed size "${extra.size_name}" — cloned as a separate version with the SAME design JSON. Upload the real ${extra.size_name} layout for it.`);
        }
      }
      if (cloned) console.log(`[migration 045] ${cloned} version(s) cloned from multi-size templates — review them in the admin panel.`);

      await qi.dropTable('template_size_map');
    }

    // 5. One version per (family, language, size). A plain unique key would let
    //    duplicate text-free (NULL language) versions through, so key on a generated
    //    column that maps NULL to 0. STORED works on both MySQL 5.7+ and MariaDB 10.2+.
    if (!(await columnExists(qi, 'templates', 'language_key'))) {
      await qi.sequelize.query(
        'ALTER TABLE `templates` ADD COLUMN `language_key` INT AS (IFNULL(`language_id`, 0)) STORED AFTER `language_id`');
    }
    if (!(await indexExists(qi, 'templates', 'uq_template_version'))) {
      await qi.addIndex('templates', ['family_id', 'language_key', 'size_id'], { unique: true, name: 'uq_template_version' });
    }

    // 6. Join tables: template_id -> family_id. family.id = template.id, so every
    //    existing row stays valid; only the FK target changes.
    for (const table of JOIN_TABLES) {
      if (!(await tableExists(qi, table))) continue;
      if (await columnExists(qi, table, 'template_id')) {
        await dropForeignKeys(qi, table, 'template_id');
        await qi.sequelize.query(`ALTER TABLE \`${table}\` CHANGE \`template_id\` \`family_id\` INT NOT NULL`);
      }
      await addForeignKey(qi, table, 'family_id', 'template_families', `fk_${table}_family`);
    }

    // 7. Drop the moved columns from templates (indexes on them go with them).
    await dropForeignKeys(qi, 'templates', 'category_id');
    for (const column of MOVED) {
      if (await columnExists(qi, 'templates', column)) await qi.removeColumn('templates', column);
    }
  },

  // Best effort. Restores the columns, the size map and the join-table FKs, copying
  // family values back onto every version. It does NOT re-merge cloned versions, and
  // does not restore uq_template_name (clones share names). migrate:undo:all is
  // already broken at 032, so this exists for a targeted single-step undo only.
  async down(queryInterface, Sequelize) {
    const qi = queryInterface;
    const S  = Sequelize;

    const restore = {
      category_id:     { type: S.INTEGER, allowNull: true },
      template_type:   { type: S.ENUM('image', 'video', 'animated'), defaultValue: 'image' },
      is_premium:      { type: S.TINYINT, defaultValue: 0 },
      is_popular:      { type: S.TINYINT, allowNull: false, defaultValue: 0 },
      trending_score:  { type: S.FLOAT, defaultValue: 0 },
      views_count:     { type: S.INTEGER, defaultValue: 0 },
      downloads_count: { type: S.INTEGER, defaultValue: 0 },
      likes_count:     { type: S.INTEGER, defaultValue: 0 },
    };
    for (const [column, def] of Object.entries(restore)) {
      if (!(await columnExists(qi, 'templates', column))) await qi.addColumn('templates', column, def);
    }
    await qi.sequelize.query(
      `UPDATE templates t JOIN template_families f ON f.id = t.family_id
          SET t.category_id = f.category_id, t.template_type = f.template_type, t.is_premium = f.is_premium,
              t.is_popular = f.is_popular, t.trending_score = f.trending_score, t.views_count = f.views_count,
              t.downloads_count = f.downloads_count, t.likes_count = f.likes_count`);
    await addForeignKey(qi, 'templates', 'category_id', 'template_categories', 'templates_ibfk_1', 'SET NULL');

    for (const table of JOIN_TABLES) {
      if (!(await tableExists(qi, table)) || !(await columnExists(qi, table, 'family_id'))) continue;
      await dropForeignKeys(qi, table, 'family_id');
      await qi.sequelize.query(`ALTER TABLE \`${table}\` CHANGE \`family_id\` \`template_id\` INT NOT NULL`);
      await addForeignKey(qi, table, 'template_id', 'templates', `fk_${table}_template`);
    }

    if (!(await tableExists(qi, 'template_size_map'))) {
      await qi.createTable('template_size_map', {
        id:          { type: S.INTEGER, primaryKey: true, autoIncrement: true },
        template_id: { type: S.INTEGER, allowNull: false, references: { model: 'templates', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
        size_id:     { type: S.INTEGER, allowNull: false, references: { model: 'template_sizes', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      });
      await qi.addIndex('template_size_map', ['template_id', 'size_id'], { unique: true, name: 'uq_template_size' });
      await qi.sequelize.query('INSERT INTO template_size_map (template_id, size_id) SELECT id, size_id FROM templates WHERE size_id IS NOT NULL');
    }

    if (await indexExists(qi, 'templates', 'uq_template_version')) await qi.removeIndex('templates', 'uq_template_version');
    if (await columnExists(qi, 'templates', 'language_key')) await qi.removeColumn('templates', 'language_key');
    await dropForeignKeys(qi, 'templates', 'size_id');
    if (await columnExists(qi, 'templates', 'size_id')) await qi.removeColumn('templates', 'size_id');
    await dropForeignKeys(qi, 'templates', 'family_id');
    if (await columnExists(qi, 'templates', 'family_id')) await qi.removeColumn('templates', 'family_id');

    await qi.dropTable('template_families');
  },
};
