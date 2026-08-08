'use strict';

/**
 * The owner's brand palette — the colours pulled from their logo that branded
 * designs are generated in.
 *
 * A JSON column rather than a join table, for two reasons. It is a value object:
 * always read and written whole, never queried by colour, capped at six entries.
 * And `businesses` already stores `social_links` and `operating_hours` exactly
 * this way, so a palette table would be the odd one out.
 *
 * Shape: an ORDERED array of `{ hex, label? }`, where position carries the
 * meaning (first = primary). That matches `brand_series_colors`, which already
 * orders a palette by display_order with no named roles, so the render side reads
 * a user's palette the same way it reads a curated one.
 *
 * These are custom hex values, NOT references to the shared `colors` taxonomy —
 * that table is a curated catalogue for brand series, whereas a user's colours
 * come off their own logo and will rarely match a catalogued one.
 *
 * Mirrors src/models/business.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('businesses', 'brand_colors', {
      type: Sequelize.JSON,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('businesses', 'brand_colors');
  },
};
