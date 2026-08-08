'use strict';

/**
 * Content languages — "Preferred Languages" on the settings screen.
 *
 * This is NOT the app's UI language. It selects which TEMPLATES a user is shown:
 * pick English and Malayalam and the browse feed narrows to designs whose text is
 * in one of those. The list is admin-governed (a designer cannot invent a
 * language by typing one) which is why it is a catalogue table rather than a
 * free-text code.
 *
 * `native_name` is what the picker renders — a Tamil speaker is looking for
 * "தமிழ்", not "Tamil". `name` stays English for the admin panel and for logs.
 *
 * `templates.language_id` is NULLABLE, and null means LANGUAGE-NEUTRAL: a design
 * with no text, or symbols only, shown to everyone whatever they picked. That is
 * also what makes this safe to ship — every existing template is null, so nothing
 * disappears from anyone's feed the day filtering goes live. Content becomes
 * language-specific only as an admin tags it.
 *
 * ON DELETE SET NULL, not CASCADE: removing a language must never delete the
 * designs drawn in it — they simply become neutral until re-tagged.
 *
 * Mirrors src/models/language.model.js and src/models/template.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;

    await queryInterface.createTable('languages', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      // Short code ('en', 'ta', 'ml'). Unique and case-insensitive by collation,
      // so it is a stable key the client can hold on to.
      code:          { type: S.STRING(10), allowNull: false, unique: true },
      name:          { type: S.STRING(50), allowNull: false, unique: true },   // "Tamil"
      native_name:   { type: S.STRING(50), allowNull: false },                 // "தமிழ்"
      display_order: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      is_active:     { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      created_at:    { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      updated_at:    { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addColumn('templates', 'language_id', {
      type: S.INTEGER,
      allowNull: true,
      references: { model: 'languages', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });

    // Backs the browse filter, which is `language_id IN (…) OR language_id IS NULL`.
    await queryInterface.addIndex('templates', ['language_id'], { name: 'idx_template_language' });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('templates', 'idx_template_language');
    await queryInterface.removeColumn('templates', 'language_id');
    await queryInterface.dropTable('languages');
  },
};
