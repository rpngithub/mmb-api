'use strict';

/**
 * "Preferred Languages" — MULTIPLE per user, so a join table.
 *
 * This replaces the single `user_preferences.language` column added in
 * 000018, which was built on a wrong reading of the requirement: it meant "the
 * app's UI language", one value. The real feature is plural and selects CONTENT
 * (which templates a user is shown), so the column cannot express it and is
 * dropped here rather than left behind to be mistaken for the real thing.
 *
 * An empty set is meaningful and normal: a user who has never opened the screen
 * has no rows, and the API treats that as English (see user.service
 * DEFAULT_LANGUAGE_CODES). Storing that default as rows instead would make
 * "never chose" indistinguishable from "deliberately chose English only".
 *
 * Mirrors src/models/userLanguage.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;

    await queryInterface.createTable('user_languages', {
      id:      { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      language_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'languages', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
    });

    // One row per (user, language) — makes the set-replace idempotent.
    await queryInterface.addIndex('user_languages', ['user_id', 'language_id'], { unique: true, name: 'uq_user_language' });

    await queryInterface.removeColumn('user_preferences', 'language');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('user_preferences', 'language', {
      type: Sequelize.STRING(10), allowNull: false, defaultValue: 'en',
    });
    await queryInterface.dropTable('user_languages');
  },
};
