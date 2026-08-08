'use strict';

/**
 * Per-user preferences.
 *
 * A table with TYPED COLUMNS rather than a JSON blob on `users`, because these
 * get queried, not just displayed: "everyone who left email notifications on",
 * "send this in Hindi". You cannot index a JSON blob for that, and the whole
 * point of storing a channel preference is to filter on it when sending.
 *
 * One row per user, created lazily on first write — `GET` applies the defaults
 * below when no row exists, so a user who never opens the settings screen costs
 * nothing.
 *
 * The notify_* flags are TRANSACTIONAL channels (subscription expiry, order
 * updates). Marketing consent is deliberately NOT one of them: it needs to be its
 * own column so a campaign query can never sweep up someone who only agreed to
 * receipts. Add it as a separate field when that feature arrives.
 *
 * Mirrors src/models/userPreference.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;

    await queryInterface.createTable('user_preferences', {
      id:      { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: {
        type: S.INTEGER, allowNull: false, unique: true,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      // BCP-47-ish short code ('en', 'hi', 'ta'). Kept as a plain string rather
      // than an ENUM so adding a language is a data change, not a migration.
      language:        { type: S.STRING(10), allowNull: false, defaultValue: 'en' },
      notify_push:     { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      notify_email:    { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      notify_whatsapp: { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      created_at:      { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      updated_at:      { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_preferences');
  },
};
