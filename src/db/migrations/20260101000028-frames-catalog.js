'use strict';

/**
 * Frames, rebuilt as an admin-curated catalogue.
 *
 * The old `user_frames` was a private upload record: a user posted an s3_key and
 * got a row. That concept is gone. A frame is now content the ADMIN authors, the
 * same way templates are — categorised, browsable in a store, free or priced —
 * and `user_frames` becomes the record of WHICH catalogue frames a user owns.
 *
 * The old rows are dropped rather than migrated. They point at files uploaded
 * under the retired `user_frame` slot and carry no category, no design content
 * and no price, so there is nothing to map them onto; keeping them would only
 * put unreachable rows in a table whose meaning has changed underneath them.
 * `down()` restores the old SHAPE, not the old data.
 *
 * Ownership, not entitlement. Unlike premium variants (which unlock through the
 * active plan — see services/variantAccess.service.js), a premium frame is bought
 * outright for a per-frame price. So there is no frames↔plans join here: what a
 * user owns is exactly the set of `user_frames` rows, and it survives a lapsed
 * subscription because it was never granted by one.
 *
 * A purchase writes its `user_frames` row up front with status 'pending' and the
 * payment attached, then flips to 'active' when Razorpay confirms — the same
 * pending-then-activate shape `user_subscriptions` already uses, which is what
 * lets the existing webhook stay the single source of truth.
 *
 * Mirrors src/models/frameCategory.model.js, frame.model.js, userFrame.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');

    const created = { type: S.DATE, allowNull: false, defaultValue: now };
    const updated = { type: S.DATE, allowNull: false, defaultValue: now };
    const bothTs  = { created_at: created, updated_at: updated };

    // ---- frame_categories ----
    // The store's filter chips ("Branding Frames", "Promotional Frames"). Flat, not
    // a tree: template_categories nests because a catalogue of thousands needs
    // drill-down, but frames are a short curated shelf and the design shows one row
    // of chips. `display_order` drives that row (adminCrud `reorderable`).
    await queryInterface.createTable('frame_categories', {
      id:            { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid:           { type: S.UUID, allowNull: false, unique: true },
      name:          { type: S.STRING(100), allowNull: false },
      slug:          { type: S.STRING(120), allowNull: true, unique: true },
      display_order: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      is_active:     { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      ...bothTs,
    });

    // ---- frames ----
    await queryInterface.createTable('frames', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      // Nullable so a frame can be drafted before it is filed, but the publish gate
      // (services/framePublish.js) refuses to make it `active` without one — an
      // uncategorised frame is unreachable in a store browsed only by chips.
      category_id: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'frame_categories', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      name:             { type: S.STRING(200), allowNull: false },
      description:      { type: S.TEXT, allowNull: true },
      thumbnail_s3_key: { type: S.STRING(500), allowNull: true },
      // The design payload, same contract as `templates.content`: the editor reads
      // it and fills its slots from the owner's Brand Kit (logo, phone, email —
      // the bar along the bottom of every frame in the design). A frame is
      // therefore NOT a flat overlay image, which is why there is no s3_key here.
      content:          { type: S.TEXT('long'), allowNull: true },
      // The store's two tabs. 'static' rather than the old 'image' so the value
      // reads the same as the tab the user taps.
      frame_type:       { type: S.ENUM('static', 'animated'), allowNull: false, defaultValue: 'static' },
      is_premium:       { type: S.TINYINT, allowNull: false, defaultValue: 0 },
      // What the user actually pays, inclusive of nothing — GST is added at
      // checkout by withGst(), exactly as plan prices are.
      price:            { type: S.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      // Display-only "was" price, struck through beside `price` ("₹0 (₹100)").
      // NULL = no promotion, show `price` alone.
      strike_price:     { type: S.DECIMAL(10, 2), allowNull: true },
      display_order:    { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      status:           { type: S.ENUM('draft', 'active', 'inactive'), allowNull: false, defaultValue: 'draft' },
      created_by: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'admin_users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      ...bothTs,
    });

    // The store lists one tab of one category at a time, newest/ordered first.
    await queryInterface.addIndex('frames', ['status', 'frame_type', 'category_id'], { name: 'ix_frames_browse' });

    // ---- retire the old `user_frame` upload slot ----
    // Those uploads are still charged against each owner's storage quota, and with
    // the slot gone the media library can no longer list them — so the user could
    // never reclaim the space. Refund the bytes and drop the ledger rows before the
    // records that referenced them disappear. The S3 objects are left for the
    // lifecycle rule; a migration has no credentials to delete them, and an
    // over-refund would be worse than an orphaned file.
    await queryInterface.sequelize.query(`
      UPDATE user_quota_usage q
        JOIN (
          SELECT user_id, SUM(bytes) AS freed
            FROM user_uploads
           WHERE slot = 'user_frame'
        GROUP BY user_id
        ) f ON f.user_id = q.user_id
         SET q.storage_used_bytes = GREATEST(CAST(q.storage_used_bytes AS SIGNED) - CAST(f.freed AS SIGNED), 0)
    `);
    await queryInterface.sequelize.query("DELETE FROM user_uploads WHERE slot = 'user_frame'");

    // ---- user_frames (rebuilt) ----
    await queryInterface.dropTable('user_frames');

    await queryInterface.createTable('user_frames', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      user_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      // RESTRICT, not CASCADE: deleting a frame someone paid for must fail loudly
      // rather than silently erase the thing they bought. Admins retire a frame by
      // setting status='inactive', which hides it from the store and leaves every
      // existing owner untouched.
      frame_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'frames', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      acquired_via: { type: S.ENUM('free', 'purchase'), allowNull: false, defaultValue: 'free' },
      // Set for 'purchase' only; the payment that bought it. SET NULL so pruning
      // old payment rows can never destroy the ownership record itself.
      payment_id: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'payments', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      // pending -> paid for but not yet confirmed by Razorpay (free adds skip it)
      // active  -> owned and usable
      // removed -> taken off the shelf by the user. Kept, not deleted: a paid frame
      //            must be re-addable without paying twice.
      status:       { type: S.ENUM('pending', 'active', 'removed'), allowNull: false, defaultValue: 'active' },
      acquired_at:  { type: S.DATE, allowNull: true },
      ...bothTs,
    });

    // One row per (user, frame), ever — the row is reused on remove/re-add, which
    // is what makes "already bought" a lookup rather than a scan of payments.
    await queryInterface.addIndex('user_frames', ['user_id', 'frame_id'], { unique: true, name: 'uq_user_frame' });

    // ---- businesses.active_frame_id ----
    // The "Active Frames" pointer: the one frame applied to this business's designs.
    // It references `frames` rather than `user_frames` so the editor can resolve the
    // design payload in one hop; the service checks ownership before ever setting it.
    // SET NULL so retiring a frame cannot orphan a business row.
    await queryInterface.addColumn('businesses', 'active_frame_id', {
      type: S.INTEGER,
      allowNull: true,
      references: { model: 'frames', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
  },

  async down(queryInterface, Sequelize) {
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');

    await queryInterface.removeColumn('businesses', 'active_frame_id');
    await queryInterface.dropTable('user_frames');
    await queryInterface.dropTable('frames');
    await queryInterface.dropTable('frame_categories');

    // Restore the pre-frames-catalogue shape (empty — the data is not recoverable).
    await queryInterface.createTable('user_frames', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      user_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      name:       { type: S.STRING(200), allowNull: false },
      s3_key:     { type: S.STRING(500), allowNull: false },
      frame_type: { type: S.ENUM('image', 'animated'), defaultValue: 'image' },
      is_active:  { type: S.TINYINT, defaultValue: 1 },
      created_at: { type: S.DATE, allowNull: false, defaultValue: now },
    });
  },
};
