'use strict';

/**
 * Themes become a premium, plan-scoped surface.
 *
 * - themes gains `description` (the marketing copy shown on a theme card) and a
 *   display-only `likes_count` (the ❤️ figure on the card; no per-user like table yet).
 * - theme_plan_restrictions maps a theme to the plans entitled to its templates.
 *   Access rule: a user may open a theme's templates iff their ACTIVE subscription's
 *   plan_id appears here. A theme with NO rows is locked to everyone (explicit grant
 *   required) — the theme CARD stays a public teaser, but the templates never load.
 * - theme_business_categories tags a theme with the businesses it suits (the pill
 *   tags on the card). Display/filter only today; enables "match to the logged-in
 *   user's industry" filtering later with no further schema change.
 *
 * Mirrors src/models/theme.model.js, themePlanRestriction.model.js and
 * themeBusinessCategory.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S  = Sequelize;
    const pk = () => ({ type: S.INTEGER, primaryKey: true, autoIncrement: true });
    const fk = (model, { allowNull = false, onDelete = 'CASCADE' } = {}) => ({
      type: S.INTEGER,
      allowNull,
      references: { model, key: 'id' },
      onDelete,
      onUpdate: 'CASCADE',
    });

    // ---- themes: card metadata ----
    await queryInterface.addColumn('themes', 'description', { type: S.TEXT, allowNull: true });
    await queryInterface.addColumn('themes', 'likes_count', { type: S.INTEGER, allowNull: false, defaultValue: 0 });

    // ---- theme_plan_restrictions (theme <-> plan entitlement) ----
    await queryInterface.createTable('theme_plan_restrictions', {
      id:       pk(),
      theme_id: fk('themes'),
      plan_id:  fk('plans'),
    });

    // ---- theme_business_categories (theme <-> business category, display/filter) ----
    await queryInterface.createTable('theme_business_categories', {
      id:                   pk(),
      theme_id:             fk('themes'),
      business_category_id: fk('business_categories'),
    });

    // unique pair guards on the new join tables (mirrors the initial-schema style)
    await queryInterface.addIndex('theme_plan_restrictions', ['theme_id', 'plan_id'], { unique: true, name: 'uq_theme_plan' });
    await queryInterface.addIndex('theme_business_categories', ['theme_id', 'business_category_id'], { unique: true, name: 'uq_theme_bizcat' });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryInterface.dropTable('theme_business_categories');
    await queryInterface.dropTable('theme_plan_restrictions');
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
    await queryInterface.removeColumn('themes', 'likes_count');
    await queryInterface.removeColumn('themes', 'description');
  },
};
