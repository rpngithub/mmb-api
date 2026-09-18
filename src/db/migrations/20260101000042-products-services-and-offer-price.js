'use strict';

/**
 * "Manage Products" grows into products AND services, with two new price/detail
 * fields, and gains an Active/Inactive toggle that is distinct from delete.
 *
 *   - type          product | service. One table: both are "things this business
 *                   offers", listed together on the storefront and the Near Me
 *                   card, and differ only in which optional detail they carry.
 *   - unit          "Unit/Weight" on a product ("1 Kg", "500 ml", "per piece").
 *                   Display text, never parsed. Products only.
 *   - service_area  Where a service is offered ("Nagercoil"). Services only.
 *   - offer_price   The selling price when set; `price` then becomes the struck-
 *                   through "actual" price. Never above `price`.
 *   - deleted_at    Until now DELETE /products/{uid} set is_active=0 and the owner
 *                   list showed active rows only, so "inactive" and "deleted" were
 *                   one state. The screen now has an In Active tab (a row the owner
 *                   can see and re-enable) beside a trash icon (gone for good), so
 *                   the two are separated: is_active is the toggle, deleted_at is
 *                   the delete. Rows found with is_active=0 at migration time are
 *                   backfilled as deleted — under the old API they were already
 *                   unreachable from the owner list, so nothing the user could see
 *                   changes, whereas leaving them would resurrect every old delete
 *                   (image files already released) as a ghost In Active card.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    await queryInterface.addColumn('products', 'type', {
      type: S.ENUM('product', 'service'), allowNull: false, defaultValue: 'product', after: 'business_id',
    });
    await queryInterface.addColumn('products', 'unit', {
      type: S.STRING(50), allowNull: true, after: 'name',
    });
    await queryInterface.addColumn('products', 'service_area', {
      type: S.STRING(200), allowNull: true, after: 'unit',
    });
    await queryInterface.addColumn('products', 'offer_price', {
      type: S.DECIMAL(10, 2), allowNull: true, after: 'price',
    });
    await queryInterface.addColumn('products', 'deleted_at', {
      type: S.DATE, allowNull: true, after: 'is_active',
    });
    await queryInterface.sequelize.query(
      'UPDATE products SET deleted_at = NOW() WHERE is_active = 0 AND deleted_at IS NULL',
    );
  },

  async down(queryInterface) {
    // Deleted rows fold back into is_active=0, which is what they were before.
    await queryInterface.sequelize.query('UPDATE products SET is_active = 0 WHERE deleted_at IS NOT NULL');
    await queryInterface.removeColumn('products', 'deleted_at');
    await queryInterface.removeColumn('products', 'offer_price');
    await queryInterface.removeColumn('products', 'service_area');
    await queryInterface.removeColumn('products', 'unit');
    await queryInterface.removeColumn('products', 'type');
  },
};
