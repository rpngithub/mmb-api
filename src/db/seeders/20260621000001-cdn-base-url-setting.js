// Public CDN/base URL the frontend prepends to an S3 key to render an asset:
//   imageUrl = `${cdn_base_url}/${key}`  (e.g. templates/<uid>/bg.png)
// Exposed via GET /config (is_public = 1). Set the real value per environment from
// the admin panel (/admin/app-settings) or here.
module.exports = {
  async up(queryInterface) {
    await queryInterface.bulkInsert('app_settings', [
      {
        key: 'cdn_base_url',
        value: '',
        type: 'string',
        group: 'media',
        is_public: 1,
        description: 'Public base URL (CDN/bucket) prepended to S3 keys to build asset URLs',
      },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('app_settings', { key: 'cdn_base_url' }, {});
  },
};
