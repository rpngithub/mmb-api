'use strict';

/**
 * The Billing & Payments screen needs three things `payments` never recorded.
 *
 *   - payment_method / payment_method_detail   HOW it was paid. Razorpay hands
 *     this to the webhook on every captured payment (`method`, plus `vpa`, `card`,
 *     `bank` or `wallet` depending on the method); we simply dropped it. Detail is
 *     a short display string ("UPI · pr***@okaxis", "VISA •• 4242") — never the
 *     full instrument. Both stay NULL for a payment whose only confirmation was
 *     the client callback (it carries no method); the webhook fills them in.
 *   - razorpay_invoice_id   Razorpay auto-generates an invoice for each recurring
 *     charge (subscription.charged carries its id). Recorded for reconciliation
 *     only — one-time Orders get no such invoice, so nothing user-facing may
 *     depend on it. Our own invoice/receipt document covers every payment.
 *   - invoice_number   Our GST invoice number: MMB/<FY>/<6 digits>, sequential per
 *     Indian financial year, issued once when the payment first succeeds and never
 *     changed. `invoice_counters` is the per-FY sequence; a single atomic UPSERT
 *     hands out the next value, so concurrent confirmations cannot share one.
 *     Rows that succeeded before this migration get no number retroactively —
 *     one is issued the first time their document is requested, so the sequence
 *     never contains a number older than its issue.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    await queryInterface.addColumn('payments', 'payment_method', {
      type: S.ENUM('upi', 'card', 'netbanking', 'wallet', 'emi', 'other'), allowNull: true, after: 'razorpay_signature',
    });
    await queryInterface.addColumn('payments', 'payment_method_detail', {
      type: S.STRING(100), allowNull: true, after: 'payment_method',
    });
    await queryInterface.addColumn('payments', 'razorpay_invoice_id', {
      type: S.STRING(100), allowNull: true, after: 'payment_method_detail',
    });
    await queryInterface.addColumn('payments', 'invoice_number', {
      type: S.STRING(30), allowNull: true, after: 'razorpay_invoice_id',
    });
    await queryInterface.addIndex('payments', ['invoice_number'], { name: 'uq_payments_invoice_number', unique: true });
    // The history list: one user's payments, newest first.
    await queryInterface.addIndex('payments', ['user_id', 'created_at'], { name: 'idx_payments_user_created' });

    await queryInterface.createTable('invoice_counters', {
      fy:      { type: S.STRING(10), primaryKey: true },
      last_no: { type: S.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('invoice_counters');
    await queryInterface.removeIndex('payments', 'idx_payments_user_created');
    await queryInterface.removeIndex('payments', 'uq_payments_invoice_number');
    await queryInterface.removeColumn('payments', 'invoice_number');
    await queryInterface.removeColumn('payments', 'razorpay_invoice_id');
    await queryInterface.removeColumn('payments', 'payment_method_detail');
    await queryInterface.removeColumn('payments', 'payment_method');
  },
};
