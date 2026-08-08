'use strict';

/**
 * Brand Kit fonts — the third tab beside Logo and Brand Colours.
 *
 * ONE table for both sources, distinguished by a nullable owner:
 *   user_id IS NULL  -> curated library font, offered to everyone
 *   user_id = <id>   -> that user's own upload, private to them
 *
 * The alternative — a library table plus a separate user-font table — would force
 * every reference to be "either/or": two nullable columns on businesses, two
 * lookups, two permission checks. With one table the brand kit points at `fonts`
 * and ownership is a single question: is it a library font, or mine?
 *
 * `font_files` exists because a family is not a file. Real typography needs at
 * least regular and bold, often italics, and the browser wants woff2 while a
 * server-side renderer may want ttf. One row per (weight, style, format).
 *
 * `font_languages` records SCRIPT COVERAGE, and it is the reason this table is
 * worth having at all rather than reusing `assets`. A Devanagari font cannot
 * render Tamil. Now that users pick preferred content languages, someone browsing
 * Tamil templates could otherwise choose a Hindi-only brand font and have every
 * headline render as boxes. Empty coverage = unspecified, treated as "shows
 * everywhere" so a font is never hidden merely because nobody classified it.
 *
 * `heading_font_id` / `body_font_id` are NAMED ROLES rather than an ordered list
 * (unlike brand colours): templates bind type by role, and "the second font"
 * carries no meaning a renderer can use. ON DELETE SET NULL — removing a font
 * must never delete the businesses styled with it.
 *
 * Mirrors src/models/font.model.js, fontFile.model.js and business.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;

    await queryInterface.createTable('fonts', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      // NULL = curated library font. Otherwise the owner; their font dies with them.
      user_id: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      family:        { type: S.STRING(100), allowNull: false },
      is_premium:    { type: S.TINYINT, allowNull: false, defaultValue: 0 },
      display_order: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      is_active:     { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      created_at:    { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      updated_at:    { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
    });

    // One family name per owner. Deliberately NOT globally unique: a user naming
    // their upload "Roboto" must not collide with the library's "Roboto".
    // (MySQL treats NULLs as distinct, so library uniqueness is enforced by the
    // admin API instead — see the fonts registration in admin.router.)
    await queryInterface.addIndex('fonts', ['user_id', 'family'], { unique: true, name: 'uq_font_owner_family' });

    await queryInterface.createTable('font_files', {
      id: { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      font_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'fonts', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      weight: { type: S.INTEGER, allowNull: false, defaultValue: 400 },   // 100-900
      style:  { type: S.ENUM('normal', 'italic'), allowNull: false, defaultValue: 'normal' },
      format: { type: S.ENUM('woff2', 'woff', 'ttf', 'otf'), allowNull: false },
      s3_key: { type: S.STRING(500), allowNull: false },
    });

    await queryInterface.addIndex('font_files', ['font_id', 'weight', 'style', 'format'], { unique: true, name: 'uq_font_file_variant' });

    await queryInterface.createTable('font_languages', {
      id: { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      font_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'fonts', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      language_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'languages', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
    });

    await queryInterface.addIndex('font_languages', ['font_id', 'language_id'], { unique: true, name: 'uq_font_language' });

    for (const col of ['heading_font_id', 'body_font_id']) {
      await queryInterface.addColumn('businesses', col, {
        type: S.INTEGER,
        allowNull: true,
        references: { model: 'fonts', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('businesses', 'body_font_id');
    await queryInterface.removeColumn('businesses', 'heading_font_id');
    await queryInterface.dropTable('font_languages');
    await queryInterface.dropTable('font_files');
    await queryInterface.dropTable('fonts');
  },
};
