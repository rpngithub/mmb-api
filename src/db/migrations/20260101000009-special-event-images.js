'use strict';

// Give special events their own cover + hero images (like the brands.live festival
// calendar cards). thumbnail_s3_key = card cover, banner_s3_key = wide hero. Both are
// S3 keys under the `events/` root, uploaded via the typed-upload slots
// `special_event_thumbnail` / `special_event_banner`. Nullable — an event may still
// rely on its linked template thumbnails if no cover is set.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('special_events', 'thumbnail_s3_key', {
      type: Sequelize.STRING(500), allowNull: true, after: 'description',
    });
    await queryInterface.addColumn('special_events', 'banner_s3_key', {
      type: Sequelize.STRING(500), allowNull: true, after: 'thumbnail_s3_key',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('special_events', 'banner_s3_key');
    await queryInterface.removeColumn('special_events', 'thumbnail_s3_key');
  },
};
