'use strict';

/**
 * Video uploads, and upload limits as admin-tunable settings.
 *
 * 1. Fourteen app_settings rows (group `uploads`) replace the hardcoded 10 MB /
 *    20-file / 50-file caps: per-file size, files per request and total bytes per
 *    request, plus the allowed image and video MIME types — separately for user
 *    and admin uploads. User rows are public so the app can refuse a file the
 *    moment it is picked. Values carry over nothing: these are new knobs, seeded
 *    from src/constants/uploadTypes.js DEFAULTS. A row that already exists (an
 *    admin created it by hand) is left as it is.
 *
 * 2. Metadata the client reports for a video (the server cannot decode one):
 *    user_uploads gains duration_ms + poster_s3_key; assets gains width, height,
 *    duration_ms, bytes and content_type. All nullable, so existing rows are
 *    untouched.
 *
 * Mirrors src/models/userUpload.model.js and src/models/asset.model.js.
 */
const { DEFAULTS, key } = require('../../constants/uploadTypes');

const WHO = { user: 'user', admin: 'admin' };

const settingRows = () => Object.entries(DEFAULTS).flatMap(([scope, d]) => {
  const isPublic = scope === 'user' ? 1 : 0;
  const row = (k, value, type, description) => ({
    key: k, value: String(value), type, group: 'uploads', is_public: isPublic, description,
  });
  return [
    row(key.maxMb(scope, 'image'), d.image.max_mb, 'integer', `Largest single image a ${WHO[scope]} upload may be, in MB.`),
    row(key.maxMb(scope, 'video'), d.video.max_mb, 'integer', `Largest single video a ${WHO[scope]} upload may be, in MB (at most 5120).`),
    row(key.batchMaxFiles(scope, 'image'), d.image.batch_max_files, 'integer', `Most non-video files in one ${WHO[scope]} presign request.`),
    row(key.batchMaxFiles(scope, 'video'), d.video.batch_max_files, 'integer', `Most videos in one ${WHO[scope]} presign request.`),
    row(key.batchTotalMb(scope), d.batch_max_total_mb, 'integer', `Combined size of all files in one ${WHO[scope]} presign request, in MB. Over it, the whole request is refused.`),
    row(key.types(scope, 'image'), JSON.stringify(d.image.types), 'json', `Image MIME types a ${WHO[scope]} may upload (JSON array).${scope === 'user' ? ' image/svg+xml is never accepted here.' : ''}`),
    row(key.types(scope, 'video'), JSON.stringify(d.video.types), 'json', `Video MIME types a ${WHO[scope]} may upload (JSON array).`),
  ];
});

const COLUMNS = {
  user_uploads: (S) => ({
    duration_ms:   { type: S.INTEGER,     allowNull: true },
    poster_s3_key: { type: S.STRING(500), allowNull: true },
  }),
  assets: (S) => ({
    width:        { type: S.INTEGER,     allowNull: true },
    height:       { type: S.INTEGER,     allowNull: true },
    duration_ms:  { type: S.INTEGER,     allowNull: true },
    bytes:        { type: S.BIGINT,      allowNull: true },
    content_type: { type: S.STRING(100), allowNull: true },
  }),
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const [existing] = await queryInterface.sequelize.query(
      "SELECT `key` FROM app_settings WHERE `group` = 'uploads' OR `key` LIKE 'upload\\_%'",
    );
    const have = new Set(existing.map((r) => r.key));
    const rows = settingRows().filter((r) => !have.has(r.key));
    if (rows.length) await queryInterface.bulkInsert('app_settings', rows);
    console.log(`[migration 054] seeded ${rows.length} upload setting(s)`);

    for (const [table, cols] of Object.entries(COLUMNS)) {
      const present = await queryInterface.describeTable(table);
      for (const [col, def] of Object.entries(cols(Sequelize))) {
        if (!present[col]) await queryInterface.addColumn(table, col, def);
      }
    }
  },

  async down(queryInterface, Sequelize) {
    for (const [table, cols] of Object.entries(COLUMNS)) {
      const present = await queryInterface.describeTable(table);
      for (const col of Object.keys(cols(Sequelize))) {
        if (present[col]) await queryInterface.removeColumn(table, col);
      }
    }
    await queryInterface.bulkDelete('app_settings', { key: settingRows().map((r) => r.key) }, {});
  },
};
