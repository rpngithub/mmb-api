'use strict';

/**
 * User notifications — the inbox, its catalogue, and admin broadcasts.
 *
 * There was no notification feature at all before this. The nearest thing was
 * `app_banners`, which the client PULLS and which has no per-user state: its
 * `is_dismissible` is a hint to the renderer, not a record that anyone dismissed
 * anything. An inbox needs read/unread/dismissed PER USER, so it needs its own
 * table, and banners are left alone.
 *
 * Three layers, deliberately separate:
 *
 *   notification_categories   the ten scenarios from the product sheet. A table
 *                             rather than an ENUM because the app groups the inbox
 *                             by them and users mute them one at a time — both of
 *                             which want a stable id and an admin-editable label.
 *
 *   notification_templates    WHAT can be sent and the rules for sending it: copy,
 *                             CTA, audience, throttle, and how it is triggered.
 *                             Keyed by an immutable `code` — that string is the
 *                             contract between a seeded row and the service call
 *                             site that dispatches it, and it prefixes every
 *                             dedupe_key, so renaming one would orphan a user's
 *                             whole history for that notification.
 *
 *   user_notifications        WHAT was actually sent, one row per user per send,
 *                             carrying a RENDERED SNAPSHOT of the copy. Editing a
 *                             template must not retroactively rewrite what someone
 *                             already read, and listing the inbox must not re-run
 *                             the renderer for every row on every badge poll.
 *
 * The load-bearing constraint in the whole feature is `uq_user_notif_dedupe`.
 * Cron jobs here run IN-PROCESS ON EVERY API INSTANCE with no queue (see
 * src/server.js), and the scans re-evaluate the same predicates every night.
 * Every write path — event hook, scan, campaign chunk, webhook retry, second
 * instance — is an INSERT that either lands or is ignored. There is no send-log
 * and no coordination table. The advisory locks the jobs take exist only to stop
 * N instances repeating the same expensive scan; this index is what makes a lost
 * lock harmless.
 *
 * Table shapes follow the frames catalogue (20260101000028) and quota top-ups
 * (20260101000030): integer PK + separate uid, TINYINT booleans, named indexes,
 * explicit onDelete, JSON columns read through src/utils/jsonColumn.js.
 *
 * Mirrors src/models/notificationCategory.model.js, notificationTemplate.model.js,
 * notificationCampaign.model.js, userNotification.model.js,
 * userNotificationSetting.model.js, notificationJobRun.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');

    const created = { type: S.DATE, allowNull: false, defaultValue: now };
    const updated = { type: S.DATE, allowNull: false, defaultValue: now };
    const bothTs  = { created_at: created, updated_at: updated };

    // ---- notification_categories ----
    await queryInterface.createTable('notification_categories', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      name:        { type: S.STRING(100), allowNull: false },
      slug:        { type: S.STRING(120), allowNull: false },
      description: { type: S.TEXT, allowNull: true },
      // Client-side icon key ("credit-card", "calendar"), not an asset — the app
      // ships the glyphs and the admin only picks which one.
      icon:          { type: S.STRING(60), allowNull: true },
      display_order: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      is_active:     { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      ...bothTs,
    });

    // Both are addressable: `slug` from the app's deep links, `name` for the
    // admin's case-insensitive duplicate check (MySQL _ci collation).
    await queryInterface.addIndex('notification_categories', ['slug'], {
      unique: true, name: 'uq_notif_category_slug',
    });
    await queryInterface.addIndex('notification_categories', ['name'], {
      unique: true, name: 'uq_notif_category_name',
    });

    // ---- notification_templates ----
    await queryInterface.createTable('notification_templates', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      // IMMUTABLE on system rows. snake_case, e.g. 'payment_failed'. Enforced in
      // the admin CRUD's beforeWrite rather than by the DB, because admin-authored
      // templates may legitimately rename theirs before anything has been sent.
      code: { type: S.STRING(80), allowNull: false },
      // SET NULL rather than RESTRICT: losing the grouping label should degrade the
      // inbox to "ungrouped", not block deleting a category or orphan the template.
      category_id: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'notification_categories', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      title:      { type: S.STRING(200), allowNull: false },
      body:       { type: S.TEXT, allowNull: false },
      cta_label:  { type: S.STRING(100), allowNull: true },
      // An app ROUTE KEY ('subscription.plans', 'templates.browse'), not a URL. The
      // client maps it to a screen; app_banners uses a URL because a banner may
      // legitimately point off-app, but every notification here lands in-product.
      cta_action: { type: S.STRING(100), allowNull: true },
      cta_params: { type: S.JSON, allowNull: true },
      image_s3_key: { type: S.STRING(500), allowNull: true },
      // The `{{placeholders}}` this template's trigger is able to fill, and the
      // fallbacks for any that arrive empty. Declared rather than inferred so the
      // admin CRUD gate can check the copy against the contract IN BOTH DIRECTIONS
      // at save time — an undeclared token and an unused declaration are both
      // rejected. That moves the failure to the one admin pressing Save, instead
      // of to forty thousand users receiving a literal
      // "Only {{credits}} AI credits remaining".
      variables:         { type: S.JSON, allowNull: true },
      variable_defaults: { type: S.JSON, allowNull: true },
      //   event      — a service call site fires it (payment failed, first design)
      //   scheduled  — an hourly job scans a date column and an offset
      //   behavioral — a nightly job evaluates a predicate over users/businesses
      //   recurring  — a nightly job checks a cadence (weekly, every N days)
      //   manual     — only an admin campaign sends it
      // IMMUTABLE on system rows for the same reason as `code`: it decides which
      // job owns the row, and flipping it strands the template where nothing scans.
      trigger_type: {
        type: S.ENUM('event', 'scheduled', 'behavioral', 'recurring', 'manual'),
        allowNull: false, defaultValue: 'manual',
      },
      // Per-trigger knobs, shape depending on trigger_type: { anchor, offset_days }
      // for scheduled, { predicate, days } for behavioural, { recurrence } for
      // recurring. JSON because each trigger family wants different fields and a
      // column per field would be mostly-NULL for every row.
      trigger_config: { type: S.JSON, allowNull: true },
      // The sheet splits several notifications by who they are for — the personal
      // user's festival copy differs from the business owner's. Two templates with
      // distinct codes, filtered here, rather than one template with a fork inside.
      audience_account_type: {
        type: S.ENUM('all', 'business', 'personal'), allowNull: false, defaultValue: 'all',
      },
      audience_plan: {
        type: S.ENUM('all', 'free', 'paid', 'trial'), allowNull: false, defaultValue: 'all',
      },
      // Forward seam for push/email. The send path asserts ["in_app"] today; the
      // column exists so adding FCM later is a data change plus a channel
      // dispatcher, not a reshape of every row in two tables.
      channels: { type: S.JSON, allowNull: true },
      // SEND-ORDER priority: which message wins when the daily cap bites. The scan
      // jobs walk their templates in descending order within a tick, so the cap is
      // spent on the most valuable notification rather than on whichever scan
      // happened to run first. An integer because it only ever needs to sort.
      priority: { type: S.INTEGER, allowNull: false, defaultValue: 50 },
      // DISPLAY priority, copied onto the inbox row — how the app renders it
      // (accent colour, pinning). Deliberately a separate column from `priority`
      // above: they answer different questions and collapsing them would mean an
      // admin could not make a message sort last but still render as urgent.
      display_priority: {
        type: S.ENUM('low', 'normal', 'high'), allowNull: false, defaultValue: 'normal',
      },
      // Marketing vs transactional. Bypasses BOTH fatigue caps, the min-gap, the
      // per-template cooldown, quiet hours, and `user_preferences.notify_marketing`
      // — a payment receipt is not marketing and must land at 2am if that is when
      // the payment failed. Transactional sends are also excluded from cap
      // COUNTING, so a burst of receipts cannot crowd out a nudge.
      is_promotional: { type: S.TINYINT, allowNull: false, defaultValue: 0 },
      // Minimum HOURS between two sends of this template to one user. The sheet
      // asks for it directly: "once a week (max)" -> 168, "every 10-14 days" -> 240.
      // Hours rather than days because "occasionally" wants tuning without a
      // migration. NULL = no cooldown.
      cooldown_hours: { type: S.INTEGER, allowNull: true },
      // Lifetime cap per user — "Start Your Business Journey" should give up after
      // three attempts rather than nag forever. NULL = unlimited. Counts only rows
      // still inside the retention window; see the retention job.
      max_occurrences: { type: S.INTEGER, allowNull: true },
      is_dismissible:  { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      // Auto-hide from the inbox after N days — a festival reminder is noise a week
      // later. NULL = never expires.
      expires_after_days: { type: S.INTEGER, allowNull: true },
      is_active: { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      // Seeded from the product sheet. Copy, CTA, throttle and the active toggle
      // stay editable; `code` and `trigger_type` are frozen. DELETE is wired to
      // adminCrud's softDelete, so "not deletable" costs the factory nothing —
      // `protect` would have been wrong here because it blocks update AND delete
      // indistinguishably, and these rows must remain editable.
      is_system: { type: S.TINYINT, allowNull: false, defaultValue: 0 },
      created_by: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'admin_users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      ...bothTs,
    });

    await queryInterface.addIndex('notification_templates', ['code'], {
      unique: true, name: 'uq_notif_template_code',
    });
    // Each job's "which templates do I own this tick", already in send order.
    await queryInterface.addIndex('notification_templates', ['trigger_type', 'is_active', 'priority'], {
      name: 'ix_notif_templates_trigger',
    });

    // ---- notification_campaigns ----
    // The admin broadcast. Separate from templates because a campaign is an EVENT
    // ("we shipped 2.4, tell everyone") with a lifecycle, an audience snapshot and
    // a progress cursor — none of which belong on a reusable catalogue row.
    await queryInterface.createTable('notification_campaigns', {
      id:  { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      // Internal label for the admin list; never shown to users.
      name: { type: S.STRING(200), allowNull: false },
      // Optional: start from a catalogue template and override its copy, or write
      // the whole thing inline. RESTRICT, matching user_notifications.template_id —
      // templates are only ever soft-deleted, so this is the honest constraint.
      template_id: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'notification_templates', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      category_id: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'notification_categories', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      title:      { type: S.STRING(200), allowNull: true },
      body:       { type: S.TEXT, allowNull: true },
      cta_label:  { type: S.STRING(100), allowNull: true },
      cta_action: { type: S.STRING(100), allowNull: true },
      cta_params: { type: S.JSON, allowNull: true },
      image_s3_key: { type: S.STRING(500), allowNull: true },
      // The segment as FLAT, AND-ed filter criteria — not a nested boolean tree,
      // which would be unauditable by an admin staring at the panel and is YAGNI
      // for the campaigns this product sends. Keys are whitelisted at save time
      // (Joi .unknown(false)) and values only ever reach SQL as bind parameters.
      //
      // ONE builder turns this into a WHERE for both the "preview audience count"
      // and the fan-out. If those two ever get separate SQL they will drift, and
      // the drift is discovered by an admin who sent to three times the audience
      // they approved.
      audience: { type: S.JSON, allowNull: true },
      scheduled_at: { type: S.DATE, allowNull: true },
      status: {
        type: S.ENUM('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed'),
        allowNull: false, defaultValue: 'draft',
      },
      // The entire resumability story. Keyset, never OFFSET. Advanced AFTER the
      // chunk's insert commits: a crash between the two re-runs the chunk, whose
      // rows all collide on dedupe_key 'campaign:<id>' and are ignored. The reverse
      // order would skip those users irrecoverably. Ordering gives at-least-once;
      // the dedupe key upgrades it to exactly-once.
      cursor_user_id: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      // Snapshot of the preview count at schedule time, so the panel can show a
      // stable "estimated 41,203 at 14:02 on 3 Sep" rather than a number that
      // silently moves under the admin between approving and sending.
      audience_count: { type: S.INTEGER, allowNull: true },
      sent_count:     { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      // Recipients the dispatcher deliberately passed over — muted the category,
      // failed the audience match, hit a fatigue cap. Not errors; the admin needs
      // to see that "sent 8,412 of 10,000" is the expected outcome.
      skipped_count:  { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      failed_count:   { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      // Deliberate, audited escape hatch for a genuine announcement (a pricing
      // change, an outage). Ticking it is written to activity_logs — the audit
      // trail is the control here, not the schema. Never bypasses marketing
      // consent, only the fatigue caps.
      bypass_fatigue: { type: S.TINYINT, allowNull: false, defaultValue: 0 },
      started_at:     { type: S.DATE, allowNull: true },
      completed_at:   { type: S.DATE, allowNull: true },
      error_message:  { type: S.STRING(500), allowNull: true },
      created_by: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'admin_users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      ...bothTs,
    });

    // The dispatch tick's two lookups: promote-due, and drain-sending.
    await queryInterface.addIndex('notification_campaigns', ['status', 'scheduled_at'], {
      name: 'ix_notif_campaigns_due',
    });

    // ---- user_notifications ----
    await queryInterface.createTable('user_notifications', {
      // BIGINT, deviating from the INTEGER convention on purpose: this is the only
      // table in the schema that grows per-user-per-day, and INSERT IGNORE burns an
      // auto-increment value on every collision — of which the nightly scans
      // produce many by design.
      id:  { type: S.BIGINT, primaryKey: true, autoIncrement: true },
      uid: { type: S.UUID, allowNull: false, unique: true },
      user_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      // RESTRICT, not SET NULL. Templates are only ever soft-deleted (is_active=0),
      // so nothing legitimate is blocked — and SET NULL would silently erase a
      // user's cooldown and max_occurrences history the moment someone retired a
      // template, quietly re-opening every nag it had already exhausted.
      template_id: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'notification_templates', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      // SET NULL: a campaign is a one-off record that may legitimately be deleted,
      // and the inbox rows it produced must outlive it.
      campaign_id: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'notification_campaigns', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      category_id: {
        type: S.INTEGER, allowNull: true,
        references: { model: 'notification_categories', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      // Identifies the OCCURRENCE, not the notification: 'inactive_7d:la:2026-08-22',
      // 'festival_tomorrow:ev:37:2026-11-08'. It must be derived from state that is
      // FROZEN while the condition holds and moves when the condition breaks —
      // key it on NOW() and it fires every night the user stays dormant; key it on
      // the template alone and it never fires again after they return and lapse a
      // second time. DATE(last_active_at) has exactly the right property, which is
      // why the dormancy scans anchor on it and need no episode bookkeeping.
      //
      // NOT NULL with no default, always: MySQL permits unlimited NULLs in a unique
      // index, so a single nullable write path would silently switch deduping off
      // for the whole feature.
      //
      // Readable rather than hashed — the first production question will be "why
      // did this user get three of these", and a SELECT should answer it.
      // 191 chars keeps (INT + VARCHAR) inside InnoDB's 3072-byte index limit
      // under utf8mb4.
      dedupe_key: { type: S.STRING(191), allowNull: false },
      // Denormalised from the template. Every fatigue query filters on it, and
      // joining notification_templates in that hot path to read one TINYINT is
      // silly. Immutable per row — a sent notification's nature does not change —
      // so there is nothing to keep in sync.
      is_promotional: { type: S.TINYINT, allowNull: false, defaultValue: 0 },
      // RENDERED SNAPSHOT, not a reference. "Only 20 AI credits remaining" was true
      // when it was sent; re-rendering it at read time would make it lie about a
      // moment that has passed, desynchronise the copy from the CTA chosen for it,
      // and turn the most-polled endpoint in the app into an N+1 across five
      // tables. It is also what makes "editable copy" mean "future sends" rather
      // than "retroactively rewrite what users were already told".
      title:      { type: S.STRING(200), allowNull: false },
      body:       { type: S.TEXT, allowNull: false },
      cta_label:  { type: S.STRING(100), allowNull: true },
      cta_action: { type: S.STRING(100), allowNull: true },
      cta_params: { type: S.JSON, allowNull: true },
      image_s3_key: { type: S.STRING(500), allowNull: true },
      // The values actually substituted. ~100 bytes for "what exactly did we tell
      // them", and the input a future re-render pass would need for localisation.
      variables: { type: S.JSON, allowNull: true },
      priority:       { type: S.ENUM('low', 'normal', 'high'), allowNull: false, defaultValue: 'normal' },
      is_dismissible: { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      // DELIVERY state, distinct from the read/dismiss state below.
      //   scheduled -> held back by quiet hours; invisible to the inbox
      //   delivered -> visible
      // The row is INSERTED at decision time even when deferred, so a retry of the
      // same event collides on dedupe_key instead of queueing a second copy. That
      // is why quiet hours is a status plus a deliver_at, and not "don't insert
      // yet".
      status:     { type: S.ENUM('scheduled', 'delivered'), allowNull: false, defaultValue: 'delivered' },
      deliver_at: { type: S.DATE, allowNull: false, defaultValue: now },
      read_at:      { type: S.DATE, allowNull: true },
      dismissed_at: { type: S.DATE, allowNull: true },
      expires_at:   { type: S.DATE, allowNull: true },
      created_at: created,
    });

    // THE constraint the whole feature rests on. See the file header.
    await queryInterface.addIndex('user_notifications', ['user_id', 'dedupe_key'], {
      unique: true, name: 'uq_user_notif_dedupe',
    });
    // The inbox list and the unread badge. read_at / dismissed_at are residual
    // filters over one user's small delivered set, which is cheap enough that a
    // sixth index on this table is not worth the write amplification.
    await queryInterface.addIndex('user_notifications', ['user_id', 'status', 'deliver_at'], {
      name: 'ix_user_notif_inbox',
    });
    // The daily/weekly caps and the min-gap check, on every promotional dispatch.
    await queryInterface.addIndex('user_notifications', ['user_id', 'is_promotional', 'created_at'], {
      name: 'ix_user_notif_fatigue',
    });
    // Per-template cooldown and max_occurrences.
    await queryInterface.addIndex('user_notifications', ['user_id', 'template_id', 'created_at'], {
      name: 'ix_user_notif_cooldown',
    });
    // Serves both the quiet-hours release (status='scheduled', a tiny slice) and
    // the nightly retention prune, where the leading column is near-constant so it
    // degrades to a deliver_at range scan — which is exactly what the prune wants.
    //
    // NOTE for whoever reaches for partitioning when this table gets large:
    // PARTITION BY RANGE (TO_DAYS(deliver_at)) with monthly DROP PARTITION is the
    // textbook answer and it is BLOCKED here. MySQL requires every unique key to
    // contain the partitioning column, and uq_user_notif_dedupe deliberately does
    // not — being independent of time is the entire point of that key. The
    // escalation is an archive table (no unique index, partitionable) fed by
    // INSERT..SELECT, not partitioning this one.
    await queryInterface.addIndex('user_notifications', ['status', 'deliver_at'], {
      name: 'ix_user_notif_dispatch',
    });

    // ---- user_notification_settings ----
    // Per-category mute. A row is written only when a user turns something OFF —
    // absent means enabled, the same lazy convention user.service#getPreferences
    // already uses for user_preferences, so switching this on costs no backfill.
    await queryInterface.createTable('user_notification_settings', {
      id: { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      category_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'notification_categories', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      in_app: { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      ...bothTs,
    });

    await queryInterface.addIndex('user_notification_settings', ['user_id', 'category_id'], {
      unique: true, name: 'uq_user_notif_setting',
    });

    // ---- notification_job_runs ----
    // One row per scan. With the jobs running in-process on every instance, each
    // console.log lands in a different container — there is otherwise no way to
    // answer "did last night's dormancy scan actually run?". A job that has been
    // failing silently for a week is the realistic failure mode of this feature,
    // and this table is what surfaces it.
    await queryInterface.createTable('notification_job_runs', {
      id:      { type: S.BIGINT, primaryKey: true, autoIncrement: true },
      job_key: { type: S.STRING(60), allowNull: false },
      // hostname + pid — which instance won the advisory lock.
      instance: { type: S.STRING(100), allowNull: true },
      // skipped_locked is the NORMAL outcome on every instance but one. It is
      // recorded rather than dropped so "nothing ran anywhere" is distinguishable
      // from "one instance ran and the rest stood down".
      status: {
        type: S.ENUM('running', 'ok', 'failed', 'skipped_locked'),
        allowNull: false, defaultValue: 'running',
      },
      scanned_count:  { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      inserted_count: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      skipped_count:  { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      error_message:  { type: S.TEXT, allowNull: true },
      started_at:     created,
      finished_at:    { type: S.DATE, allowNull: true },
    });

    await queryInterface.addIndex('notification_job_runs', ['job_key', 'started_at'], {
      name: 'ix_notif_job_runs_job',
    });

    // ---- users.last_active_at ----
    // `last_login_at` moves once per sign-in, and a refresh token lives 30 days —
    // so a user who opens the app every morning logs in about once a month, and
    // dormancy measured off login would call a daily-active user dormant. Stamped
    // by middlewares/touchActivity, throttled to at most one write per user per
    // 15 minutes: the tightest consumer is a 7-DAY threshold, so finer resolution
    // would only buy write amplification on the most-joined table in the schema.
    await queryInterface.addColumn('users', 'last_active_at', {
      type: S.DATE, allowNull: true,
    });

    // Backfill BEFORE the behavioural job can ever run. Without it every existing
    // user is NULL, and day one either notifies nobody or notifies everybody
    // depending on how the predicate happens to read — neither of which is a thing
    // to discover in production.
    await queryInterface.sequelize.query(
      'UPDATE users SET last_active_at = COALESCE(last_login_at, created_at)',
    );

    // The dormancy scans lead with (is_active, last_active_at) and nothing else,
    // so this one index is what keeps them off a full table scan.
    await queryInterface.addIndex('users', ['is_active', 'last_active_at'], {
      name: 'ix_users_active_lastactive',
    });
    // The onboarding-gap scans: a narrow created_at slice, onboarding state as the
    // residual filter.
    await queryInterface.addIndex('users', ['onboarding_completed_at', 'created_at'], {
      name: 'ix_users_onboarding',
    });
    // Same shape for the business setup-gap scans (no logo, no products, no frame).
    await queryInterface.addIndex('businesses', ['created_at'], {
      name: 'ix_businesses_created',
    });

    // ---- user_preferences.notify_marketing ----
    // The column 20260101000018 explicitly reserved: "Marketing consent must be its
    // own field when it lands, so a campaign can never be sent to someone who only
    // opted into receipts." This is that moment. Every campaign and every
    // is_promotional send ANDs it; transactional sends ignore it entirely.
    //
    // Defaults to 1 to match the existing notify_* flags — opting the whole
    // existing user base out silently would be a product decision this migration
    // has no business making on its own.
    await queryInterface.addColumn('user_preferences', 'notify_marketing', {
      type: S.TINYINT, allowNull: false, defaultValue: 1,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('user_preferences', 'notify_marketing');
    await queryInterface.removeIndex('businesses', 'ix_businesses_created');
    await queryInterface.removeIndex('users', 'ix_users_onboarding');
    await queryInterface.removeIndex('users', 'ix_users_active_lastactive');
    await queryInterface.removeColumn('users', 'last_active_at');
    await queryInterface.dropTable('notification_job_runs');
    await queryInterface.dropTable('user_notification_settings');
    await queryInterface.dropTable('user_notifications');
    await queryInterface.dropTable('notification_campaigns');
    await queryInterface.dropTable('notification_templates');
    await queryInterface.dropTable('notification_categories');
  },
};
