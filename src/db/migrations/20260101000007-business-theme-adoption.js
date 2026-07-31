'use strict';

/**
 * "Add to your Business" — business-scoped theme adoption.
 *
 * business_themes links a business to a theme the owner has adopted (added to
 * their collection). Adoption is gated at add-time (the owner's active plan must
 * entitle the theme); the link is then a DURABLE access grant — if the plan later
 * lapses the owner keeps using adopted themes, but can't adopt new ones.
 *
 * Mirrors src/models/businessTheme.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S  = Sequelize;
    const pk = () => ({ type: S.INTEGER, primaryKey: true, autoIncrement: true });
    const fk = (model, { onDelete = 'CASCADE' } = {}) => ({
      type: S.INTEGER,
      allowNull: false,
      references: { model, key: 'id' },
      onDelete,
      onUpdate: 'CASCADE',
    });

    await queryInterface.createTable('business_themes', {
      id:          pk(),
      business_id: fk('businesses'),
      theme_id:    fk('themes'),
      created_at:  { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
    });

    // one adoption row per (business, theme); also the lookup index for access checks
    await queryInterface.addIndex('business_themes', ['business_id', 'theme_id'], { unique: true, name: 'uq_business_theme' });
    await queryInterface.addIndex('business_themes', ['theme_id']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('business_themes');
  },
};
