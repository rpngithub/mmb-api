'use strict';

/**
 * Per-object record of what each user has stored, so storage quota can be
 * DECREMENTED as well as charged.
 *
 * `user_quota_usage.storage_used_bytes` is a single running counter. Charging it
 * on upload is easy; releasing it on delete is not, because by then the only way
 * to learn an object's size is a HEAD against S3 — which fails exactly when it
 * matters (object already gone, credentials expired, network blip), and every
 * failure silently drifts the counter upward with no way to detect or repair it.
 * Recording the byte count at confirm time removes that guesswork: release reads
 * the number we actually charged.
 *
 * It also makes the counter auditable — `SELECT SUM(bytes) FROM user_uploads
 * WHERE user_id = ?` is the ground truth the counter can be reconciled against.
 *
 * A row exists only for CONFIRMED uploads (see userUpload.service). An object
 * that was presigned and PUT but never confirmed has no row, was never charged,
 * and is swept by the bucket's pending-object lifecycle rule instead.
 *
 * Mirrors src/models/userUpload.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;

    await queryInterface.createTable('user_uploads', {
      id:      { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid:     { type: S.UUID, allowNull: false, unique: true },
      user_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      // The final S3 key. Unique so confirming the same upload twice cannot
      // charge the user twice.
      s3_key:       { type: S.STRING(500), allowNull: false, unique: true },
      slot:         { type: S.STRING(30), allowNull: false },
      bytes:        { type: S.BIGINT, allowNull: false, defaultValue: 0 },
      content_type: { type: S.STRING(100), allowNull: true },
      created_at:   { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
    });

    // "everything this user is storing" — the reconcile query and the release lookup.
    await queryInterface.addIndex('user_uploads', ['user_id'], { name: 'idx_user_upload_user' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_uploads');
  },
};
