'use strict';

/**
 * Two settings-screen features.
 *
 * 1. WATERMARK (`businesses.watermark_enabled`). The owner opts into stamping
 *    THEIR OWN branding — logo, falling back to business name — onto the designs
 *    they export. It is a paid feature, gated by the `custom_watermark` boolean
 *    plan feature (see the accompanying seeder).
 *
 *    Only the preference lives here. The API never renders an export — the app
 *    composes the image and `project_exports` merely records the result — so the
 *    stamping is client-side. What the server owns is whether the user is ALLOWED
 *    to switch it on, which is why enabling it is refused without the entitlement
 *    rather than left to the client to honour.
 *
 *    Kept on `businesses` rather than `user_preferences` because it is business
 *    branding and it sits under "My Business Settings" in the app. It also has to
 *    be per-business the day one account can own several.
 *
 * 2. FEEDBACK (`feedbacks`). The emoji rating + optional note from the Feedback
 *    screen. Registered users only, so `user_id` is NOT NULL — an anonymous
 *    channel would need a different design (abuse handling, no reply path).
 *    ON DELETE CASCADE: a deleted account takes its feedback with it.
 *
 * Mirrors src/models/business.model.js and src/models/feedback.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;

    await queryInterface.addColumn('businesses', 'watermark_enabled', {
      type: S.TINYINT,
      allowNull: false,
      defaultValue: 0,   // off until the owner turns it on (and may do so)
    });

    await queryInterface.createTable('feedbacks', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      user_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      // 1-5, matching the five faces on the screen. Required: the face is the
      // point of the form and the note is optional.
      rating:     { type: S.TINYINT, allowNull: false },
      message:    { type: S.TEXT, allowNull: true },
      // Captured for support triage — which build a complaint came from matters
      // more than anything the user can tell you about it.
      app_version: { type: S.STRING(30), allowNull: true },
      platform:    { type: S.STRING(30), allowNull: true },
      created_at:  { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
    });

    // "everything from this user" (support looking up a complainant) and the
    // admin list's default newest-first ordering.
    await queryInterface.addIndex('feedbacks', ['user_id'], { name: 'idx_feedback_user' });
    await queryInterface.addIndex('feedbacks', ['rating'],  { name: 'idx_feedback_rating' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('feedbacks');
    await queryInterface.removeColumn('businesses', 'watermark_enabled');
  },
};
