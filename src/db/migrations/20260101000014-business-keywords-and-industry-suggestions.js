'use strict';

/**
 * Two signup-time additions to the business profile.
 *
 * 1. KEYWORDS (`business_tags`). At signup the owner picks the tags that best fit
 *    their products & services — surfaced in the app as "My Keywords". These are
 *    the SAME rows as `tags`: the suggestion list for an industry comes from
 *    `business_category_tags`, and the owner's picks land here. There is no such
 *    thing as a custom keyword — every keyword must already exist in `tags`, so
 *    this is a plain M2M with no moderation column.
 *
 * 2. CUSTOM SUB-INDUSTRY (`status` + `suggested_by_user_id` on business_categories).
 *    When an owner can't find their sub-industry they pick "Others" and type one.
 *    That becomes a PENDING row in this very table, parented to the industry they
 *    did find, and the business links to it straight away. Pending rows carry
 *    is_active = 0 so every existing public catalogue read (all of which filter
 *    `is_active: 1`) keeps ignoring them with no change — the row is invisible
 *    until an admin approves it, at which point it becomes an ordinary industry
 *    and the businesses already pointing at it light up with no data migration.
 *
 *    `status` is the moderation state and `is_active` stays the visibility switch;
 *    they are deliberately separate so an admin can retire an approved industry
 *    without it re-entering the moderation queue. Existing rows default to
 *    'approved' — they were all created by admins.
 *
 * Mirrors src/models/businessTag.model.js and src/models/businessCategory.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;

    // ---- business_tags (the owner's "My Keywords" picks) ----
    await queryInterface.createTable('business_tags', {
      id:          { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      business_id: { type: S.INTEGER, allowNull: false, references: { model: 'businesses', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      tag_id:      { type: S.INTEGER, allowNull: false, references: { model: 'tags',       key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    });

    // One row per (business, keyword) — makes the set replace idempotent and backs
    // the "keywords for this business" read.
    await queryInterface.addIndex('business_tags', ['business_id', 'tag_id'], { unique: true, name: 'uq_business_tag' });
    // Reverse lookup ("which businesses use this keyword") + backs the second FK.
    await queryInterface.addIndex('business_tags', ['tag_id']);

    // ---- Moderation columns on business_categories ----
    await queryInterface.addColumn('business_categories', 'status', {
      type: S.ENUM('approved', 'pending', 'rejected'),
      allowNull: false,
      defaultValue: 'approved',
    });

    // Who suggested it (null for admin-created industries). SET NULL rather than
    // CASCADE: deleting the suggester must not delete an industry other businesses
    // may already be pointing at.
    await queryInterface.addColumn('business_categories', 'suggested_by_user_id', {
      type: S.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });

    // Backs the admin moderation queue (GET /admin/business-categories?status=pending).
    await queryInterface.addIndex('business_categories', ['status'], { name: 'idx_business_category_status' });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('business_categories', 'idx_business_category_status');
    await queryInterface.removeColumn('business_categories', 'suggested_by_user_id');
    await queryInterface.removeColumn('business_categories', 'status');
    await queryInterface.dropTable('business_tags');
  },
};
