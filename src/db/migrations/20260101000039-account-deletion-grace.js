'use strict';

/**
 * Self-deactivation now leads to deletion. Until this, "deactivate" only switched
 * the account off and every business, product, project, upload and quota row
 * stayed exactly where it was, forever. Now it starts a clock: once the grace
 * period passes, jobs/accountPurge.job.js wipes everything the user owns (see
 * services/accountPurge.service.js for what "everything" means, and what the
 * tombstone keeps).
 *
 *   - users.deactivated_at  when THEY deactivated. Set by self-deactivation only;
 *                           an admin switching an account off is moderation, not a
 *                           deletion request, and does not stamp it. Cleared when
 *                           an admin reactivates — that cancels the purge.
 *   - users.purged_at       stamped by the job once the wipe is done. A purged row
 *                           is a tombstone: no PII, no content, kept only so
 *                           payments and the audit log still resolve.
 *
 * The grace period lives in app_settings so it can be changed from the admin
 * panel without a deploy. Inserted here rather than in a seeder because seeders
 * do not re-run on a database that already exists.
 *
 * Accounts deactivated BEFORE this migration have no deactivated_at and are not
 * purged. That is deliberate: they did not agree to deletion.
 */
const SETTING = {
  key:         'account_deletion_grace_hours',
  value:       '24',
  type:        'integer',
  group:       'accounts',
  is_public:   0,
  description: 'Hours between a user deactivating their own account and its data being permanently deleted. Admin reactivation within this window cancels the deletion.',
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    await queryInterface.addColumn('users', 'deactivated_at', { type: S.DATE, allowNull: true, after: 'is_active' });
    await queryInterface.addColumn('users', 'purged_at',      { type: S.DATE, allowNull: true, after: 'deactivated_at' });
    // What the purge job scans: due-and-not-yet-purged.
    await queryInterface.addIndex('users', ['deactivated_at', 'purged_at'], { name: 'idx_users_purge_due' });

    const [rows] = await queryInterface.sequelize.query(
      'SELECT id FROM app_settings WHERE `key` = :key', { replacements: { key: SETTING.key } },
    );
    if (!rows.length) await queryInterface.bulkInsert('app_settings', [SETTING]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('app_settings', { key: SETTING.key }, {});
    await queryInterface.removeIndex('users', 'idx_users_purge_due');
    await queryInterface.removeColumn('users', 'purged_at');
    await queryInterface.removeColumn('users', 'deactivated_at');
  },
};
