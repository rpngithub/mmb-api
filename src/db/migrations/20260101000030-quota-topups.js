'use strict';

/**
 * Quota top-ups — buying more of a metered feature.
 *
 * Until now a quota was whatever the active plan said it was. `plan_features`
 * declared the limit, `user_quota_usage` counted against it, and the only way to
 * get more was to change plan. This adds a second, PURCHASED source of quota that
 * sits on top of the plan allowance and never expires.
 *
 * Two shapes of quota, and top-ups behave differently in each:
 *
 *   GAUGE  (`storage`, reset_period 'never') — the counter is an occupancy LEVEL.
 *          A top-up permanently raises the ceiling; grants keep `consumed` at 0
 *          forever and deleting a file frees the purchased headroom again, because
 *          what was bought is capacity, not a one-time transfer.
 *
 *   FLOW   (`ai_credits`, reset_period 'monthly') — the counter is a TALLY that is
 *          zeroed each cycle. A top-up cannot simply raise the limit here: the
 *          reset would hand the same purchased credits back every month, forever.
 *          So spending is SPLIT at the moment it happens — the plan allowance is
 *          filled first and the remainder is debited against grant rows, which are
 *          never reset. The counter therefore only ever holds plan-allowance usage
 *          and is safe to zero; the grants only ever hold purchased usage.
 *
 * That split is why `user_quota_grants` carries `consumed` alongside `quantity`
 * instead of the balance being derived from the counter.
 *
 * Mirrors src/models/quotaPack.model.js, userQuotaGrant.model.js,
 * quotaUsageEvent.model.js. Table shapes follow the frames catalogue
 * (20260101000028): integer PK + separate uid, TINYINT booleans, DECIMAL(10,2)
 * money, named indexes, explicit onDelete.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');

    const created = { type: S.DATE, allowNull: false, defaultValue: now };
    const updated = { type: S.DATE, allowNull: false, defaultValue: now };
    const bothTs  = { created_at: created, updated_at: updated };

    // ---- feature_types.is_topupable ----
    // Which features may be sold as a pack at all. Data rather than a hardcoded
    // key list in the service, so turning downloads into a top-uppable feature
    // later is an admin edit instead of a deploy. Defaults to 0: a feature has to
    // be opted IN, because selling quota for something nothing meters would take
    // money for nothing.
    await queryInterface.addColumn('feature_types', 'is_topupable', {
      type: S.TINYINT, allowNull: false, defaultValue: 0,
    });

    await queryInterface.sequelize.query(
      "UPDATE feature_types SET is_topupable = 1 WHERE `key` IN ('ai_credits', 'storage')",
    );

    // ---- quota_packs ----
    // The admin-managed catalogue: "500 AI Credits — ₹99". Bought per pack, like
    // a frame, and deliberately NOT tied to a plan — a top-up is extra headroom
    // for the plan you already have, not a different entitlement.
    await queryInterface.createTable('quota_packs', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      // RESTRICT: a pack that has been sold points at the feature its grants are
      // denominated in. Losing that mapping would leave balances that no longer
      // mean anything.
      feature_type_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'feature_types', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      name:        { type: S.STRING(150), allowNull: false },
      description: { type: S.TEXT, allowNull: true },
      // In the FEATURE's own unit — credits for ai_credits, MEGABYTES for storage
      // — exactly like `plan_features.value`. One unit convention across both
      // sources of quota means quota.service's LIMIT_SCALE is the only place bytes
      // ever enter the picture.
      quantity:      { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      // PRE-tax, per the utils/gst.js contract. GST is added at checkout.
      price:         { type: S.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      // Display-only "was" price, struck through beside `price`, same as frames.
      strike_price:  { type: S.DECIMAL(10, 2), allowNull: true },
      // Merchandising ribbon on the pack card ("Best value", "Most popular").
      badge:         { type: S.STRING(40), allowNull: true },
      display_order: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      status:        { type: S.ENUM('draft', 'active', 'inactive'), allowNull: false, defaultValue: 'draft' },
      created_by: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'admin_users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      ...bothTs,
    });

    // The store shows the packs for ONE feature at a time, in admin order.
    await queryInterface.addIndex('quota_packs', ['status', 'feature_type_id', 'display_order'], {
      name: 'ix_quota_packs_browse',
    });

    // ---- user_quota_grants ----
    // The durable balance ledger. One row per purchase (or admin hand-out); the
    // user's top-up balance for a feature is the sum over their active rows.
    await queryInterface.createTable('user_quota_grants', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      user_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      feature_type_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'feature_types', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      // Which pack was bought, for reporting. SET NULL — deleting a retired pack
      // must never destroy the record of what someone paid for.
      quota_pack_id: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'quota_packs', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      // SNAPSHOTTED from the pack at purchase, in the feature's own unit. Read
      // through quota_pack_id instead and editing a pack would retroactively
      // change what everyone who already bought it received.
      quantity: { type: S.BIGINT, allowNull: false, defaultValue: 0 },
      // How much of this grant has been spent. FLOWS only — a gauge leaves this at
      // 0 because its counter already tracks occupancy directly.
      consumed: { type: S.BIGINT, allowNull: false, defaultValue: 0 },
      source:   { type: S.ENUM('purchase', 'admin_grant'), allowNull: false, defaultValue: 'purchase' },
      payment_id: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'payments', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      // pending -> ordered, not yet confirmed by Razorpay. Contributes nothing.
      // active  -> spendable
      // revoked -> withdrawn by an admin. Kept as the audit record, never deleted.
      status:     { type: S.ENUM('pending', 'active', 'revoked'), allowNull: false, defaultValue: 'pending' },
      // Why, for admin grants — "regenerated after a failed export", a ticket id.
      note:       { type: S.STRING(255), allowNull: true },
      granted_at: { type: S.DATE, allowNull: true },
      ...bothTs,
    });

    // Idempotency. One grant per payment, so a webhook and a client callback that
    // both land cannot credit the same purchase twice. MySQL permits many NULLs in
    // a unique index, which is exactly what admin grants (no payment) need — the
    // same property `uq_user_frame` relies on for its own guarantee.
    //
    // Note there is deliberately NO unique on (user_id, quota_pack_id): buying the
    // same 500-credit pack five times must produce five grants. A frame is an
    // ownership record; this is a balance.
    await queryInterface.addIndex('user_quota_grants', ['payment_id'], {
      unique: true, name: 'uq_grant_payment',
    });

    // The balance query: SUM over one user's active grants for one feature.
    await queryInterface.addIndex('user_quota_grants', ['user_id', 'feature_type_id', 'status'], {
      name: 'ix_grants_balance',
    });

    // ---- quota_usage_events ----
    // Every spend and every refund, one row each. The Usage screen's "breakdown by
    // tool" is a GROUP BY over this rather than a column per tool, so adding an AI
    // feature needs no schema change — and it doubles as the audit trail for "I was
    // charged credits and got nothing back".
    await queryInterface.createTable('quota_usage_events', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      user_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      feature_type_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'feature_types', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      // VARCHAR against a code-side map (src/constants/quotaSources.js), not an
      // ENUM: a new AI tool should not need a migration to appear in the breakdown.
      source: { type: S.STRING(40), allowNull: false, defaultValue: 'other' },
      // Counter units (BYTES for storage, 1 per action elsewhere). NEGATIVE for a
      // release, so summing the ledger reconciles against the counter the same way
      // SUM(user_uploads.bytes) reconciles storage_used_bytes.
      amount:     { type: S.BIGINT, allowNull: false, defaultValue: 0 },
      // How the spend was funded. Lets the breakdown answer "which of these came
      // out of the top-up I bought" without re-deriving it from limits that have
      // since changed.
      from_plan:  { type: S.BIGINT, allowNull: false, defaultValue: 0 },
      from_topup: { type: S.BIGINT, allowNull: false, defaultValue: 0 },
      // What caused it, loosely — ('project_export', 812). Not an FK: the referenced
      // row may legitimately be deleted later and the usage record must outlive it.
      ref_type:   { type: S.STRING(40), allowNull: true },
      ref_id:     { type: S.INTEGER, allowNull: true },
      created_at: created,
    });

    // The breakdown query: one user, one feature, this period.
    await queryInterface.addIndex('quota_usage_events', ['user_id', 'feature_type_id', 'created_at'], {
      name: 'ix_quota_events_breakdown',
    });

    // ---- payments.purchase_type ----
    // The discriminator the fulfilment router never had. It used to infer the
    // purchasable from absence — "a payment with no subscription_id is a frame" —
    // which worked only while frames were the sole standalone purchase. A third
    // kind makes that inference wrong, so record what was bought instead of
    // guessing it.
    //
    // Nullable, and the router still falls back to frames when it is NULL, so any
    // order created before this migration and confirmed after it still fulfils.
    await queryInterface.addColumn('payments', 'purchase_type', {
      type: S.ENUM('subscription', 'frame', 'quota_pack'), allowNull: true,
    });

    await queryInterface.sequelize.query(
      "UPDATE payments SET purchase_type = IF(subscription_id IS NOT NULL, 'subscription', 'frame')",
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('payments', 'purchase_type');
    await queryInterface.dropTable('quota_usage_events');
    await queryInterface.dropTable('user_quota_grants');
    await queryInterface.dropTable('quota_packs');
    await queryInterface.removeColumn('feature_types', 'is_topupable');
  },
};
