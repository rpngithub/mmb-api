'use strict';

// Adds a human-readable `slug` to the taxonomy tables that the PUBLIC catalog
// filters by, so clients can pass `?parent=restaurant-food` / `?category=...`
// instead of an internal integer id they'd have to look up first. Slugs are the
// primary friendly key; uid and legacy int id remain accepted (see catalogRef).
//
// Safe one-step change (expand-only): add a NULLABLE column, backfill it from the
// existing name, then add a UNIQUE index. Currently-running code neither reads nor
// writes `slug`, so it stays happy during a rolling deploy.
const slugify = require('../../utils/slugify');

const TABLES = [
  'business_categories',
  'asset_categories',
  'theme_groups',
  'faq_categories',
  'template_categories',
  'template_sizes',
  'tags',
];

const indexName = (table) => `uq_${table}_slug`;

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const table of TABLES) {
      await queryInterface.addColumn(table, 'slug', {
        type: Sequelize.STRING(120),
        allowNull: true,
      });

      // Backfill from name. Names are already unique on most of these tables, but
      // (a) asset_categories/tags are not guaranteed unique and (b) two distinct
      // names can slugify to the same string ("A & B" vs "A B"). De-dupe within
      // the table by appending -2, -3, … so the UNIQUE index below always holds.
      const [rows] = await queryInterface.sequelize.query(
        `SELECT id, name FROM \`${table}\` ORDER BY id ASC`,
      );
      const seen = new Set();
      for (const row of rows) {
        const base = slugify(row.name) || `item-${row.id}`;
        let slug = base;
        let n = 2;
        while (seen.has(slug)) slug = `${base}-${n++}`;
        seen.add(slug);
        await queryInterface.sequelize.query(
          `UPDATE \`${table}\` SET slug = ? WHERE id = ?`,
          { replacements: [slug, row.id] },
        );
      }

      // Case-insensitive uniqueness follows the default utf8mb4_*_ci collation,
      // matching how slugify normalizes case — "Help" and "help" can't both exist.
      await queryInterface.addIndex(table, ['slug'], { unique: true, name: indexName(table) });
    }
  },

  async down(queryInterface) {
    for (const table of TABLES) {
      await queryInterface.removeIndex(table, indexName(table));
      await queryInterface.removeColumn(table, 'slug');
    }
  },
};
