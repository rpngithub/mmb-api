'use strict';

/**
 * The BUSINESS / PERSONAL fork at signup ("What brings you here?").
 *
 * A PERSONAL account skips industry, sub-industry and business details entirely
 * and gets NO `businesses` row — it is just a user who makes designs. A BUSINESS
 * account continues through the industry picker and finishes by creating its one
 * business.
 *
 * `account_type` is NULL until the user answers step 2, which is exactly what
 * "onboarding hasn't started" looks like — existing users all read as NULL and
 * are re-asked, which is correct: nobody has answered this question yet.
 *
 * `onboarding_completed_at` is the freeze point. The account type is settable
 * only while it is NULL (the in-flow "SWITCH TO PERSONAL" button, and the back
 * arrow, both land inside that window); afterwards it is immutable. Completion is
 * stamped when a PERSONAL user picks their type — there is nothing further to ask
 * them — or when a BUSINESS user creates their business at the last step. A user
 * who abandons the flow midway stays NULL and is re-asked on next login, which is
 * the behaviour we want.
 *
 * Mirrors src/models/user.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'account_type', {
      type: Sequelize.ENUM('business', 'personal'),
      allowNull: true,
      defaultValue: null,
    });

    await queryInterface.addColumn('users', 'onboarding_completed_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('users', 'onboarding_completed_at');
    await queryInterface.removeColumn('users', 'account_type');
  },
};
