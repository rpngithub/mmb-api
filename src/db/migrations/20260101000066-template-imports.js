'use strict';

/**
 * Template bulk import: one batch per upload, one item per manifest row (= one
 * template version). See docs/template-bulk-import-design.md.
 *
 *   template_import_batches — the durable state of an import the admin panel
 *     drives step by step. `last_activity_at` is touched by every call; a running
 *     batch idle for a while is reported as paused (computed on read, no cron).
 *     `summary` holds the per-design outcome written at finalize.
 *
 *   template_import_items — one manifest row. `files` is the set the server
 *     decided to upload (referenced files + thumbnail), `content` the design JSON
 *     saved onto the version at complete. `created_family` / `created_version`
 *     record what THIS batch created, so cancel never deletes a row that existed
 *     before the import.
 *
 * family_id / template_id are plain integers, not FKs: an item outlives the rows
 * it points at (a version deleted by hand after the import), and the report must
 * still load.
 *
 * Portable across MariaDB 10.4 (dev), 11.8 (staging) and MySQL 8 (prod): no
 * generated columns, JSON declared as JSON (LONGTEXT on MariaDB).
 */
const TABLE_OPTS = { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' };

module.exports = {
  async up(queryInterface, Sequelize) {
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');
    const tables = await queryInterface.showAllTables();
    const has = (t) => tables.map((x) => (typeof x === 'string' ? x : x.tableName)).includes(t);

    if (!has('template_import_batches')) {
      await queryInterface.createTable('template_import_batches', {
        id:               { type: S.INTEGER, primaryKey: true, autoIncrement: true },
        uid:              { type: S.UUID, allowNull: false, unique: true },
        label:            { type: S.STRING(200), allowNull: true },
        created_by:       { type: S.INTEGER, allowNull: true },
        // draft | validated | running | completed | completed_with_issues | cancelled
        status:           { type: S.STRING(24), allowNull: false, defaultValue: 'draft' },
        total_items:      { type: S.INTEGER, allowNull: false, defaultValue: 0 },
        summary:          { type: S.JSON, allowNull: true },
        last_activity_at: { type: S.DATE, allowNull: true },
        started_at:       { type: S.DATE, allowNull: true },
        finished_at:      { type: S.DATE, allowNull: true },
        created_at:       { type: S.DATE, allowNull: false, defaultValue: now },
        updated_at:       { type: S.DATE, allowNull: false, defaultValue: now },
      }, TABLE_OPTS);
      await queryInterface.addIndex('template_import_batches', ['created_at'], { name: 'ix_tib_created' });
    }

    if (!has('template_import_items')) {
      await queryInterface.createTable('template_import_items', {
        id:              { type: S.INTEGER, primaryKey: true, autoIncrement: true },
        batch_id:        {
          type: S.INTEGER, allowNull: false,
          references: { model: 'template_import_batches', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        // Not `row_number`: that is a reserved word on MySQL 8 (prod).
        row_no:          { type: S.INTEGER, allowNull: false },
        line:            { type: S.INTEGER, allowNull: true },
        // The manifest row as given (design + version columns).
        manifest:        { type: S.JSON, allowNull: false },
        family_name:     { type: S.STRING(200), allowNull: false },
        folder:          { type: S.STRING(500), allowNull: false },
        files:           { type: S.JSON, allowNull: true },
        content:         { type: S.TEXT('long'), allowNull: true },
        family_id:       { type: S.INTEGER, allowNull: true },
        template_id:     { type: S.INTEGER, allowNull: true },
        created_family:  { type: S.TINYINT, allowNull: false, defaultValue: 0 },
        created_version: { type: S.TINYINT, allowNull: false, defaultValue: 0 },
        // awaiting_files | valid | invalid | created | uploading | completed | failed | cancelled
        stage:           { type: S.STRING(20), allowNull: false, defaultValue: 'awaiting_files' },
        // published | draft (once completed)
        result:          { type: S.STRING(12), allowNull: true },
        failed_stage:    { type: S.STRING(12), allowNull: true },
        errors:          { type: S.JSON, allowNull: true },
        warnings:        { type: S.JSON, allowNull: true },
        created_at:      { type: S.DATE, allowNull: false, defaultValue: now },
        updated_at:      { type: S.DATE, allowNull: false, defaultValue: now },
      }, TABLE_OPTS);
      await queryInterface.addIndex('template_import_items', ['batch_id', 'row_no'], { unique: true, name: 'uq_tii_batch_row' });
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('template_import_items');
    await queryInterface.dropTable('template_import_batches');
  },
};
