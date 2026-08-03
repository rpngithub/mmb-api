'use strict';

/**
 * SEO "related industries" — a curated set of cross-links between industries,
 * rendered as an internal-link block on an industry landing page (e.g. the
 * "Restaurant & Food" page links out to "Cafe", "Bakery", "Cloud Kitchen").
 *
 * Deliberate design choices:
 *   - ONE-WAY. A row means "category_id's page links to related_category_id".
 *     Setting A -> [B, C] does NOT write B -> A. Each landing page's block is
 *     exactly what the editor curated for it; a mutual link is two rows, added
 *     on purpose. Cycles are therefore legal and expected.
 *   - ORDERED. display_order is the editor's drag order, so the block renders
 *     in the sequence they arranged rather than by id or name.
 *   - No self-link: enforced at the API layer (the DB can't express it), since
 *     an industry linking to its own page is never a useful internal link.
 *
 * Mirrors src/models/businessCategoryRelated.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S  = Sequelize;
    const fk = () => ({
      type: S.INTEGER,
      allowNull: false,
      references: { model: 'business_categories', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });

    await queryInterface.createTable('business_category_related', {
      id:                  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      category_id:         fk(),  // the industry whose page shows the block
      related_category_id: fk(),  // the industry it links out to
      display_order:       { type: S.INTEGER, allowNull: false, defaultValue: 0 },
    });

    // One link per direction per pair; also the lookup index for reading a page's block.
    await queryInterface.addIndex('business_category_related', ['category_id', 'related_category_id'], { unique: true, name: 'uq_business_category_related' });
    // Reverse lookup ("who links to me") + backs the second FK.
    await queryInterface.addIndex('business_category_related', ['related_category_id']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('business_category_related');
  },
};
