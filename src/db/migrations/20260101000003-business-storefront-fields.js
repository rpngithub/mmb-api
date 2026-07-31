'use strict';

// Public "Near Me" directory: businesses become a public storefront (profile +
// products + contact + hours + ratings). The base table only had name/desc/geo/
// address, so these columns back the contact card, operating-hours block, and the
// "4.2 (20)" rating shown on the discovery and store-detail screens.
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    await queryInterface.addColumn('businesses', 'phone',           { type: S.STRING(20),  allowNull: true });
    await queryInterface.addColumn('businesses', 'whatsapp',        { type: S.STRING(20),  allowNull: true });
    await queryInterface.addColumn('businesses', 'email',           { type: S.STRING(150), allowNull: true });
    await queryInterface.addColumn('businesses', 'website',         { type: S.STRING(255), allowNull: true });
    // { instagram, facebook, youtube, ... } — flexible set, so JSON not columns.
    await queryInterface.addColumn('businesses', 'social_links',    { type: S.JSON,        allowNull: true });
    // { mon: { open: '09:00', close: '21:30' }, ..., sun: null } — null = closed.
    await queryInterface.addColumn('businesses', 'operating_hours', { type: S.JSON,        allowNull: true });
    // Denormalized rating aggregate (a future reviews table would maintain these).
    await queryInterface.addColumn('businesses', 'rating_avg',      { type: S.DECIMAL(2, 1), allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('businesses', 'rating_count',    { type: S.INTEGER,       allowNull: false, defaultValue: 0 });
  },

  async down(queryInterface) {
    for (const col of ['phone', 'whatsapp', 'email', 'website', 'social_links', 'operating_hours', 'rating_avg', 'rating_count']) {
      await queryInterface.removeColumn('businesses', col);
    }
  },
};
