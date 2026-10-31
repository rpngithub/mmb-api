'use strict';

/**
 * Buying a variant outright.
 *
 * Until now a variant opened one of two ways: the viewer's active plan is in its
 * allowed set (entitlement), or a business they own adopted it (adoption, which
 * itself needs entitlement). This adds a third, PURCHASED, for a business account
 * with no qualifying plan — the same per-item shape frames use (000028).
 *
 * 1. variants.price / strike_price. `price` is PRE-tax (utils/gst.js); NULL means
 *    the variant is not for sale, so nothing goes on sale until an admin prices it.
 *
 * 2. user_variants — the ownership record, one row per (user, variant), ever.
 *    Deliberately NOT a column on business_variants:
 *      - the `brand_series` quota meter counts distinct series in business_variants,
 *        and a purchase must never count against the plan allowance. Keeping it out
 *        of that table keeps it out of the meter without a special case;
 *      - "remove from business" deletes business_variants rows, and a purchase is
 *        the proof someone paid — it must not be deletable that way.
 *    Owned by the USER, not a business: it survives deleting the business.
 *
 * 3. payments.purchase_type gains 'variant', so fulfilment routes on what was
 *    bought rather than inferring it.
 *
 * Mirrors src/models/variant.model.js, userVariant.model.js, payment.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');

    await queryInterface.addColumn('variants', 'price', {
      type: S.DECIMAL(10, 2), allowNull: true, defaultValue: null,
    });
    // Display-only "was" price, struck through beside `price`, same as frames.
    await queryInterface.addColumn('variants', 'strike_price', {
      type: S.DECIMAL(10, 2), allowNull: true, defaultValue: null,
    });

    await queryInterface.createTable('user_variants', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      user_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      // RESTRICT: a variant someone paid for cannot be deleted out from under them.
      // Retire it with is_active=0 instead, the same rule frames follow.
      variant_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'variants', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      payment_id: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'payments', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      // pending -> ordered, not yet confirmed by Razorpay. Grants nothing.
      // active  -> owned, permanently.
      status:      { type: S.ENUM('pending', 'active'), allowNull: false, defaultValue: 'pending' },
      acquired_at: { type: S.DATE, allowNull: true },
      created_at:  { type: S.DATE, allowNull: false, defaultValue: now },
      updated_at:  { type: S.DATE, allowNull: false, defaultValue: now },
    });

    // One row per (user, variant): "do they own it?" is a single lookup, and an
    // abandoned checkout is reused rather than piling up rows.
    await queryInterface.addIndex('user_variants', ['user_id', 'variant_id'], { unique: true, name: 'uq_user_variant' });
    await queryInterface.addIndex('user_variants', ['payment_id'], { name: 'ix_user_variants_payment' });

    await queryInterface.changeColumn('payments', 'purchase_type', {
      type: S.ENUM('subscription', 'frame', 'quota_pack', 'variant'), allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    // Any 'variant' payment would fail the narrower ENUM; there is no older kind
    // it could honestly be relabelled as, so refuse rather than corrupt it.
    const [[row]] = await queryInterface.sequelize.query(
      "SELECT COUNT(*) AS n FROM payments WHERE purchase_type = 'variant'",
    );
    if (Number(row.n) > 0) throw new Error('Cannot undo 055: variant payments exist');

    await queryInterface.changeColumn('payments', 'purchase_type', {
      type: Sequelize.ENUM('subscription', 'frame', 'quota_pack'), allowNull: true,
    });
    await queryInterface.dropTable('user_variants');
    await queryInterface.removeColumn('variants', 'strike_price');
    await queryInterface.removeColumn('variants', 'price');
  },
};
