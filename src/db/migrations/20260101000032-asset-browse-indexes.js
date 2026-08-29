'use strict';

/**
 * Indexes for the public asset browse (asset.service#listAssets).
 *
 * That endpoint used to require `category` as its only anchor, which was free to
 * serve: `assets.category_id` is a real FK, so MySQL already keeps an index on it.
 * It now accepts `asset_type` as an anchor too, and `asset_type` was never indexed
 * — an unanchored-by-category call would degrade to a backward PK scan filtering
 * every row, which gets worse with each page of offset.
 *
 * Both indexes lead with the anchor and carry `status`, since every browse query
 * is scoped to `status='active'`:
 *
 *   idx_assets_type_status      -> ?asset_type=icon             (type-only browse)
 *   idx_assets_category_type    -> ?category=x&asset_type=icon  (both supplied)
 *
 * Category-only browsing keeps using the FK index and is unaffected. `asset_type`
 * is a 7-value ENUM and so weakly selective on its own — this bounds the scan
 * rather than making it cheap, and a library that grows past a few tens of
 * thousands of rows per type will want keyset pagination instead of `offset`.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('assets', ['asset_type', 'status'], {
      name: 'idx_assets_type_status',
    });
    await queryInterface.addIndex('assets', ['category_id', 'asset_type', 'status'], {
      name: 'idx_assets_category_type_status',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('assets', 'idx_assets_category_type_status');
    await queryInterface.removeIndex('assets', 'idx_assets_type_status');
  },
};
