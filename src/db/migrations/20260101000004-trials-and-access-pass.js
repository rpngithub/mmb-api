'use strict';

const { v4: uuid } = require('uuid');

// Replaces the confusing, unused `plans.is_free` flag with two real mechanics:
//   1. Free trial per plan  -> plans.trial_days (subscription plans)
//   2. ₹10 one-time access pass -> plan_type='access_pass' + pass_price/pass_days
// user_subscriptions gains `sub_type` to tag regular vs trial vs access-pass rows,
// and `plan_billing_option_id` becomes nullable (the access pass has no monthly/
// annual billing option). Also seeds a 15-day trial on Pro and the All-Access Pass.
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;

    // ---- plans: drop is_free, add plan_type + trial/pass columns ----
    await queryInterface.removeColumn('plans', 'is_free');
    await queryInterface.addColumn('plans', 'plan_type', {
      type: S.ENUM('subscription', 'access_pass'), allowNull: false, defaultValue: 'subscription',
    });
    await queryInterface.addColumn('plans', 'trial_days', { type: S.INTEGER, allowNull: true });
    await queryInterface.addColumn('plans', 'pass_price', { type: S.DECIMAL(10, 2), allowNull: true });
    await queryInterface.addColumn('plans', 'pass_days',  { type: S.INTEGER, allowNull: true });

    // ---- user_subscriptions: add sub_type, relax plan_billing_option_id ----
    await queryInterface.addColumn('user_subscriptions', 'sub_type', {
      type: S.ENUM('regular', 'trial', 'access_pass'), allowNull: false, defaultValue: 'regular',
    });
    // Only relax nullability — the existing FK constraint stays; re-declaring
    // `references` here makes MySQL silently keep the column NOT NULL.
    await queryInterface.changeColumn('user_subscriptions', 'plan_billing_option_id', {
      type: S.INTEGER, allowNull: true,
    });

    // ---- data: 15-day trial on Pro, and the All-Access Pass plan (all features unlimited) ----
    //
    // This step upgrades an EXISTING installation. On a fresh database the baseline
    // seeder already creates both plans (with explicit ids 1-3) and the pass's unlimited
    // plan_features, so running this first would insert an unexpected plan at id 1 and
    // make that seeder collide on its primary key. Skip when there is nothing to upgrade.
    const [[{ n: planCount }]] = await queryInterface.sequelize.query('SELECT COUNT(*) AS n FROM plans');
    if (Number(planCount) === 0) return;

    await queryInterface.sequelize.query("UPDATE plans SET trial_days = 15 WHERE name = 'Pro'");

    // Idempotent: a database that already has the pass (e.g. seeded, then migrated)
    // must not get a second copy.
    const [[{ n: passCount }]] = await queryInterface.sequelize.query(
      "SELECT COUNT(*) AS n FROM plans WHERE name = 'All-Access Pass'",
    );
    if (Number(passCount) > 0) return;

    await queryInterface.sequelize.query(
      "INSERT INTO plans (uid, name, description, plan_type, pass_price, pass_days, is_popular, status, display_order, created_at, updated_at) " +
      "VALUES (:uid, 'All-Access Pass', 'Try all features for 10 days', 'access_pass', 10.00, 10, 0, 'active', 99, NOW(), NOW())",
      { replacements: { uid: uuid() } },
    );
    await queryInterface.sequelize.query(
      "INSERT INTO plan_features (plan_id, feature_type_id, value, display_label, display_order, show_on_card) " +
      "SELECT p.id, ft.id, -1, CONCAT('Unlimited ', ft.label), ft.id, 0 " +
      "FROM plans p CROSS JOIN feature_types ft WHERE p.name = 'All-Access Pass'",
    );
  },

  async down(queryInterface, Sequelize) {
    const S = Sequelize;

    // remove seeded data first (plan_features -> plan, then trial flag)
    await queryInterface.sequelize.query(
      "DELETE pf FROM plan_features pf JOIN plans p ON pf.plan_id = p.id WHERE p.name = 'All-Access Pass'",
    );
    await queryInterface.sequelize.query("DELETE FROM plans WHERE name = 'All-Access Pass'");
    await queryInterface.sequelize.query("UPDATE plans SET trial_days = NULL WHERE name = 'Pro'");

    // revert user_subscriptions (restore NOT NULL; FK constraint is untouched)
    await queryInterface.changeColumn('user_subscriptions', 'plan_billing_option_id', {
      type: S.INTEGER, allowNull: false,
    });
    await queryInterface.removeColumn('user_subscriptions', 'sub_type');

    // revert plans
    await queryInterface.removeColumn('plans', 'pass_days');
    await queryInterface.removeColumn('plans', 'pass_price');
    await queryInterface.removeColumn('plans', 'trial_days');
    await queryInterface.removeColumn('plans', 'plan_type');
    await queryInterface.addColumn('plans', 'is_free', { type: S.TINYINT, defaultValue: 0 });
  },
};
