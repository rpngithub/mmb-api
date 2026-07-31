'use strict';

// Both checkout paths (one-time Orders + recurring Subscriptions) create a
// user_subscription at initiate time, before payment confirms. That requires a
// 'pending' state, added here to the existing status enum.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('user_subscriptions', 'status', {
      type:         Sequelize.ENUM('pending', 'active', 'overridden', 'cancelled', 'expired'),
      defaultValue: 'active',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('user_subscriptions', 'status', {
      type:         Sequelize.ENUM('active', 'overridden', 'cancelled', 'expired'),
      defaultValue: 'active',
    });
  },
};
