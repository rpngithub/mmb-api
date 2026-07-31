'use strict';

// DB-level backstop for the case-insensitive name uniqueness the admin API already
// enforces (adminCrud `unique: ['name']`). Each unique index guarantees the guarantee
// holds even under concurrent create requests or direct/seeder writes that bypass the API.
//
// MySQL's default utf8mb4 *_ci collation makes these indexes case-insensitive, so
// "Restaurant", "restaurant", and "RESTAURANT" collide as intended — matching the
// API's behaviour. Names are still stored verbatim (this only constrains, never mutates).
//
// Uniqueness is GLOBAL per table (not scoped by parent_id / group_id), mirroring the
// API's global check. NOTE: if a target DB already holds case-insensitive duplicate
// names in any of these tables this `up` will fail — dedupe those rows first, then re-run.
const INDEXES = [
  ['templates',           'uq_template_name'],
  ['template_categories', 'uq_template_category_name'],
  ['business_categories', 'uq_business_category_name'],
  ['themes',              'uq_theme_name'],
  ['theme_groups',        'uq_theme_group_name'],
  ['template_sizes',      'uq_template_size_name'],
  ['special_events',      'uq_special_event_name'],
];

module.exports = {
  async up(queryInterface) {
    for (const [table, name] of INDEXES) {
      await queryInterface.addIndex(table, ['name'], { unique: true, name });
    }
  },

  async down(queryInterface) {
    for (const [table, name] of INDEXES) {
      await queryInterface.removeIndex(table, name);
    }
  },
};
