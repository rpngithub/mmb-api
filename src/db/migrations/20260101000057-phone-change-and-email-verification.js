'use strict';

const { v4: uuid } = require('uuid');

/**
 * Changing the login mobile number, and the verified email it can fall back on.
 *
 *   users.email_verified_at  — stamped when the user clicks the link we emailed.
 *     NULL for every existing row: nobody has proved an address yet. Cleared again
 *     whenever the email changes. "Lost my mobile" needs it to be at least 30 days
 *     old, so a stolen session cannot plant an address and use it the same day.
 *
 *   email_verification_tokens — the links behind that stamp. `email` is the address
 *     the link was sent to, so a link issued for an old address cannot verify a new one.
 *
 *   user_otp_challenges — OTPs bound to a USER, not just a phone. `otp_codes` is keyed
 *     by (phone, purpose) because login has no user yet; a change of number is the
 *     opposite case, and an OTP that is not tied to the account asking for it is the
 *     hole this whole feature exists to close.
 *
 *   phone_change_requests — one row per attempt, either method:
 *     old_phone  — OTP to the current number, then OTP to the new one
 *     email_link — link to the verified email, then OTP to the new one
 *
 * Tokens are stored as sha256 (utils/tokenHash), never bcrypt: they are long and
 * random, and bcrypt would truncate them at 72 bytes anyway.
 *
 * Plus the in-app `phone_number_changed` notification. INSERT IGNORE, as 041, so a
 * re-run cannot clobber wording an admin has since changed.
 */
const TEMPLATE = {
  code:       'phone_number_changed',
  category:   'system',
  title:      'Mobile Number Changed',
  body:       'Your login mobile number was changed to {{phone}}. If you did not do this, contact support immediately.',
  cta_label:  'View Profile',
  cta_action: 'profile.edit',
  variables:  ['phone'],
  defaults:   {},
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');

    const userId = {
      type: S.INTEGER, allowNull: false,
      references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
    };

    await queryInterface.addColumn('users', 'email_verified_at', { type: S.DATE, allowNull: true, after: 'email' });

    await queryInterface.createTable('email_verification_tokens', {
      id:         { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      user_id:    userId,
      email:      { type: S.STRING(255), allowNull: false },
      token_hash: { type: S.CHAR(64), allowNull: false, unique: true },
      expires_at: { type: S.DATE, allowNull: false },
      used_at:    { type: S.DATE, allowNull: true },
      created_at: { type: S.DATE, allowNull: false, defaultValue: now },
    });
    await queryInterface.addIndex('email_verification_tokens', ['user_id'], { name: 'ix_email_verif_user' });

    await queryInterface.createTable('user_otp_challenges', {
      id:         { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      user_id:    userId,
      purpose:    { type: S.ENUM('phone_change_old', 'phone_change_new', 'email_change'), allowNull: false },
      // The number the OTP was texted to. Verification checks it, so an OTP sent to
      // one new number cannot confirm a different one.
      phone:      { type: S.STRING(20), allowNull: false },
      otp_hash:   { type: S.STRING(255), allowNull: false },
      attempts:   { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      expires_at: { type: S.DATE, allowNull: false },
      used_at:    { type: S.DATE, allowNull: true },
      created_at: { type: S.DATE, allowNull: false, defaultValue: now },
    });
    await queryInterface.addIndex('user_otp_challenges', ['user_id', 'purpose'], { name: 'ix_user_otp_purpose' });

    await queryInterface.createTable('phone_change_requests', {
      id:              { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid:             { type: S.UUID, allowNull: false, unique: true },
      user_id:         userId,
      method:          { type: S.ENUM('old_phone', 'email_link'), allowNull: false },
      status:          { type: S.ENUM('open', 'completed', 'cancelled'), allowNull: false, defaultValue: 'open' },
      // The number being replaced, snapshotted: the swap refuses if it changed
      // underneath the request.
      old_phone:       { type: S.STRING(20), allowNull: false },
      new_phone:       { type: S.STRING(20), allowNull: true },
      old_verified_at: { type: S.DATE, allowNull: true },
      link_token_hash: { type: S.CHAR(64), allowNull: true, unique: true },
      expires_at:      { type: S.DATE, allowNull: false },
      completed_at:    { type: S.DATE, allowNull: true },
      ip_address:      { type: S.STRING(45), allowNull: true },
      created_at:      { type: S.DATE, allowNull: false, defaultValue: now },
      updated_at:      { type: S.DATE, allowNull: false, defaultValue: now },
    });
    await queryInterface.addIndex('phone_change_requests', ['user_id', 'status'], { name: 'ix_phone_change_user_status' });

    const sql = queryInterface.sequelize;
    const [[cat]] = await sql.query(
      'SELECT id FROM notification_categories WHERE slug = :slug', { replacements: { slug: TEMPLATE.category } },
    );
    await sql.query(
      `INSERT IGNORE INTO notification_templates
         (uid, code, category_id, title, body, cta_label, cta_action,
          variables, variable_defaults, trigger_type, trigger_config,
          audience_account_type, audience_plan, channels,
          priority, display_priority, is_promotional, cooldown_hours, max_occurrences,
          is_dismissible, expires_after_days, is_active, is_system,
          created_at, updated_at)
       VALUES
         (:uid, :code, :categoryId, :title, :body, :ctaLabel, :ctaAction,
          :variables, :defaults, 'event', NULL,
          'all', 'all', :channels,
          90, 'high', 0, NULL, NULL,
          1, NULL, 1, 1,
          NOW(), NOW())`,
      {
        replacements: {
          uid:        uuid(),
          code:       TEMPLATE.code,
          categoryId: cat ? cat.id : null,
          title:      TEMPLATE.title,
          body:       TEMPLATE.body,
          ctaLabel:   TEMPLATE.cta_label,
          ctaAction:  TEMPLATE.cta_action,
          variables:  JSON.stringify(TEMPLATE.variables),
          defaults:   JSON.stringify(TEMPLATE.defaults),
          channels:   JSON.stringify(['in_app']),
        },
      },
    );
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;
    await sql.query(
      `DELETE FROM user_notifications
        WHERE template_id IN (SELECT id FROM notification_templates WHERE code = :code)`,
      { replacements: { code: TEMPLATE.code } },
    );
    await sql.query(
      'DELETE FROM notification_templates WHERE is_system = 1 AND code = :code',
      { replacements: { code: TEMPLATE.code } },
    );

    await queryInterface.dropTable('phone_change_requests');
    await queryInterface.dropTable('user_otp_challenges');
    await queryInterface.dropTable('email_verification_tokens');
    await queryInterface.removeColumn('users', 'email_verified_at');
  },
};
