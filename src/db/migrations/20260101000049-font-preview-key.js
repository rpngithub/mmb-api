'use strict';

/**
 * fonts.preview_s3_key — the font's name-only preview file.
 *
 * The editor's font picker draws every family's name in that family. A preview is
 * the font cut down to just the glyphs of its own name (a few KB), so the picker
 * can load one per visible row instead of whole font files. NULL when no faithful
 * preview exists — the font cannot draw its own name, or its format is one the
 * subsetter does not handle — and the picker then shows the name in the app font.
 *
 * Filled by src/services/fontPreview.service.js when a font's files or family
 * change; existing fonts are backfilled through POST /admin/fonts/previews/rebuild
 * (S3 work does not belong in a migration).
 *
 * Idempotent, because migrations run on boot. Mirrors src/models/font.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const cols = await queryInterface.describeTable('fonts');
    if (cols.preview_s3_key) return;
    await queryInterface.addColumn('fonts', 'preview_s3_key', {
      type: Sequelize.STRING(500), allowNull: true,
    });
  },

  async down(queryInterface) {
    const cols = await queryInterface.describeTable('fonts');
    if (cols.preview_s3_key) await queryInterface.removeColumn('fonts', 'preview_s3_key');
  },
};
