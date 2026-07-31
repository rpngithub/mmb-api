'use strict';

// FAQ category names must be unique. The admin API already rejects duplicates with
// a clean 409 (adminCrud `unique: ['name']`), but this index is the DB-level backstop.
// MySQL's default utf8mb4 *_ci collation makes the unique index case-insensitive, so
// "Help", "help", and "HELP" collide as intended.
//
// NOTE: if the target DB already holds case-insensitive duplicate names this `up` will
// fail — dedupe those rows first, then re-run.
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('faq_categories', ['name'], {
      unique: true,
      name:   'uq_faq_category_name',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('faq_categories', 'uq_faq_category_name');
  },
};
