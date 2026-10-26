'use strict';

/**
 * The account-deletion grace period is set in MINUTES, not hours, so it can be
 * short (e.g. 30 minutes) — useful for testing the purge on staging, and finer
 * control in production.
 *
 * Replaces `account_deletion_grace_hours` (migration 039) with
 * `account_deletion_grace_minutes`, carrying over whatever an admin had set:
 * hours × 60. A fresh database lands on 1440 (= the old 24-hour default).
 *
 * The purge job now runs every 5 minutes (jobs/accountPurge.job.js) so a
 * minutes-level setting is honoured to within 5 minutes rather than an hour.
 */
const OLD_KEY = 'account_deletion_grace_hours';
const NEW_KEY = 'account_deletion_grace_minutes';
const DEFAULT_MINUTES = 1440;

const SETTING = {
  key:         NEW_KEY,
  type:        'integer',
  group:       'accounts',
  is_public:   0,
  description: 'Minutes between a user deactivating their own account and its data being permanently deleted (1440 = 24 hours). Admin reactivation within this window cancels the deletion.',
};

const valueOf = async (qi, key) => {
  const [rows] = await qi.sequelize.query(
    'SELECT value FROM app_settings WHERE `key` = :key', { replacements: { key } },
  );
  return rows.length ? rows[0].value : null;
};

module.exports = {
  async up(queryInterface) {
    if ((await valueOf(queryInterface, NEW_KEY)) === null) {
      const hours   = Number.parseInt(await valueOf(queryInterface, OLD_KEY), 10);
      const minutes = Number.isFinite(hours) && hours >= 0 ? hours * 60 : DEFAULT_MINUTES;
      await queryInterface.bulkInsert('app_settings', [{ ...SETTING, value: String(minutes) }]);
      console.log(`[migration 053] ${NEW_KEY} = ${minutes}`);
    }
    await queryInterface.bulkDelete('app_settings', { key: OLD_KEY }, {});
  },

  async down(queryInterface) {
    const minutes = Number.parseInt(await valueOf(queryInterface, NEW_KEY), 10);
    // Rounded UP, so going back never shortens anyone's grace period.
    const hours = Number.isFinite(minutes) ? Math.ceil(minutes / 60) : 24;
    if ((await valueOf(queryInterface, OLD_KEY)) === null) {
      await queryInterface.bulkInsert('app_settings', [{
        key: OLD_KEY, value: String(hours), type: 'integer', group: 'accounts', is_public: 0,
        description: 'Hours between a user deactivating their own account and its data being permanently deleted. Admin reactivation within this window cancels the deletion.',
      }]);
    }
    await queryInterface.bulkDelete('app_settings', { key: NEW_KEY }, {});
  },
};
