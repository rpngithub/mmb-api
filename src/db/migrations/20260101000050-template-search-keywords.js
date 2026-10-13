'use strict';

/**
 * template_families.search_keywords — extra words a design should be found by.
 *
 * Plain-text template search (GET /templates?q=) matches a design's name, tags,
 * category, industries, special events, languages and sizes. These keywords are
 * for everything else an admin wants it found by ("bonanza", "grand opening",
 * a misspelling users type) without minting a catalogue tag that would also show
 * up in filters and pickers.
 *
 * Stored as one comma-joined, de-duplicated string (see src/utils/textSearch.js) —
 * not a JSON column — so search can LIKE it directly and reads need no parsing.
 * The model exposes it as an array.
 *
 * Idempotent, because migrations run on boot. Mirrors src/models/templateFamily.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const cols = await queryInterface.describeTable('template_families');
    if (cols.search_keywords) return;
    await queryInterface.addColumn('template_families', 'search_keywords', {
      type: Sequelize.STRING(1000), allowNull: true,
    });
  },

  async down(queryInterface) {
    const cols = await queryInterface.describeTable('template_families');
    if (cols.search_keywords) await queryInterface.removeColumn('template_families', 'search_keywords');
  },
};
