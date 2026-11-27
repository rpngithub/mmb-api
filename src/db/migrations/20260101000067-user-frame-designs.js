'use strict';

/**
 * user_frame_designs — a user's own edited copy of one frame version.
 *
 * Users edit the frames they own (the editable components beside the frame). The
 * original stays on frame_versions, which users never write to; this table holds
 * the copy, one per user per version, since a 4:5 layout is a different design from
 * a 1:1 one. GET /frames/:uid serves the copy in place of the original when the
 * picked version has one (frame.service).
 *
 *   original_updated_at  the version's updated_at when the copy was last saved.
 *                        A later admin change to the version makes the detail
 *                        response say `original_updated: true`, so the app can
 *                        offer a reset — the copy references the version's bundle
 *                        files, which that change may have replaced.
 *
 * No frame_id: a version can move between frames (frameFamilyAdmin) and a copied
 * frame_id would go stale; the version knows its frame.
 *
 * Both foreign keys cascade: a deleted user or version takes its copies with it.
 * The copies' thumbnails live under users/<user uid>/frames/, which the account
 * purge sweeps; a deleted version leaves those few small objects behind.
 *
 * Every step checks whether it already ran (MariaDB cannot roll back DDL).
 * Mirrors src/models/userFrameDesign.model.js.
 */

const exists = async (qi, sql, replacements) => {
  const [rows] = await qi.sequelize.query(sql, { replacements });
  return Number(rows[0].n) > 0;
};

const tableExists = (qi, table) => exists(qi,
  `SELECT COUNT(*) AS n FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = ?`, [table]);

const indexExists = (qi, table, name) => exists(qi,
  `SELECT COUNT(*) AS n FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, name]);

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi  = queryInterface;
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');

    if (!(await tableExists(qi, 'user_frame_designs'))) {
      await qi.createTable('user_frame_designs', {
        id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
        uid: { type: S.UUID, allowNull: false, unique: true },
        user_id: {
          type: S.INTEGER, allowNull: false,
          references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        frame_version_id: {
          type: S.INTEGER, allowNull: false,
          references: { model: 'frame_versions', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        content:             { type: S.TEXT('long'), allowNull: false },
        thumbnail_s3_key:    { type: S.STRING(500), allowNull: true },
        original_updated_at: { type: S.DATE, allowNull: true },
        created_at: { type: S.DATE, allowNull: false, defaultValue: now },
        updated_at: { type: S.DATE, allowNull: false, defaultValue: now },
      });
    }

    if (!(await indexExists(qi, 'user_frame_designs', 'uq_user_frame_design'))) {
      await qi.addIndex('user_frame_designs', ['user_id', 'frame_version_id'], { unique: true, name: 'uq_user_frame_design' });
    }
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'user_frame_designs')) await queryInterface.dropTable('user_frame_designs');
  },
};
