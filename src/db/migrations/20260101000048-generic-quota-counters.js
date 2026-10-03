'use strict';

/**
 * Every integer plan feature becomes a real, enforced quota.
 *
 * Until now `user_quota_usage` had one hardcoded column per meter (downloads,
 * shares, AI credits, template views, storage). A feature an admin added — "Brand
 * Series 2", "Video templates 100" — had no column, so it was shown on the plan
 * card and enforced nowhere. Counters move to one row per (user, feature) instead,
 * so a meter is a code entry (src/constants/quotaMeters.js), not a migration.
 *
 *   1. user_quota_counters, backfilled from the five legacy columns, which are then
 *      dropped. user_quota_usage keeps only the account's usage window — the single
 *      "Everything resets on …" date.
 *   2. The four new meters' feature types exist (an installation where an admin
 *      already created them keeps its rows — same keys, values untouched).
 *   3. The per-tool AI features are retired: AI is one top-uppable `ai_credits`
 *      pool, broken down by tool on the Usage screen. Removed only where nothing
 *      sold or granted references them.
 *   4. plans.plan_type gains 'free' — the plan accounts WITHOUT a subscription are
 *      held to. It is not a subscription plan, so GET /plans (which defaults to
 *      plan_type=subscription) never offers it for sale. An existing plan named
 *      "Free" with nothing to buy on it is converted; its status is left alone, so
 *      enforcement for free users starts only when that plan is active.
 *
 * Any OTHER integer feature an admin invented is left in place and reported: the
 * admin guard now refuses to save one, but deleting someone's plan data in a
 * migration is not this file's call.
 *
 * Mirrors src/models/userQuotaCounter.model.js and userQuotaUsage.model.js.
 */

const LEGACY = {
  downloads:      'downloads_count',
  shares:         'shares_count',
  ai_credits:     'ai_credits_used',
  template_views: 'template_views_count',
  storage:        'storage_used_bytes',
};

const NEW_METERS = [
  { key: 'business_posts_templates', label: 'Business Posts Templates', reset_period: 'monthly' },
  { key: 'video_templates',          label: 'Video Templates',          reset_period: 'monthly' },
  { key: 'brand_series',             label: 'Brand Series',             reset_period: 'monthly' },
  { key: 'frames',                   label: 'Brand Frames',             reset_period: 'never'   },
];

const RETIRED_AI = ['ai_image_generation', 'ai_bg_remover', 'ai_logo_creation'];

// Kept in step with src/constants/quotaMeters.js on purpose (a migration must not
// import app code that will keep changing after it).
const METERED = [...Object.keys(LEGACY), ...NEW_METERS.map((m) => m.key)];

module.exports = {
  async up(queryInterface, Sequelize) {
    const S   = Sequelize;
    const q   = (sql, opts) => queryInterface.sequelize.query(sql, opts);
    const now = S.literal('CURRENT_TIMESTAMP');

    // ---- 1. user_quota_counters ----
    await queryInterface.createTable('user_quota_counters', {
      id: { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      // RESTRICT, like quota_packs/grants: a feature with usage recorded against it
      // must not vanish from under the counter.
      feature_type_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'feature_types', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      // BIGINT because storage counts bytes.
      used:       { type: S.BIGINT, allowNull: false, defaultValue: 0 },
      created_at: { type: S.DATE, allowNull: false, defaultValue: now },
      updated_at: { type: S.DATE, allowNull: false, defaultValue: now },
    });
    await queryInterface.addIndex('user_quota_counters', ['user_id', 'feature_type_id'], {
      unique: true, name: 'uq_user_quota_counter',
    });

    // Backfill: one row per non-zero legacy counter. A legacy column whose feature
    // type does not exist has nothing to be enforced against, so it is skipped.
    for (const [key, column] of Object.entries(LEGACY)) {
      await q(
        `INSERT INTO user_quota_counters (user_id, feature_type_id, used, created_at, updated_at)
         SELECT u.user_id, ft.id, u.\`${column}\`, NOW(), NOW()
           FROM user_quota_usage u
           JOIN feature_types ft ON ft.\`key\` = :key
          WHERE u.\`${column}\` > 0`,
        { replacements: { key } },
      );
    }
    for (const column of Object.values(LEGACY)) {
      await queryInterface.removeColumn('user_quota_usage', column);
    }

    // ---- 2. the new meters' feature types ----
    // Only on an EXISTING installation. On a fresh database the baseline seeder
    // inserts feature types 1-5 with explicit ids after migrations run, so rows
    // added here would take those ids and make it collide — the seeder carries the
    // new meters itself instead.
    const [[{ n: featureCount }]] = await q('SELECT COUNT(*) AS n FROM feature_types');
    if (Number(featureCount) > 0) {
      for (const m of NEW_METERS) {
        await q(
          `INSERT INTO feature_types (\`key\`, label, reset_period, data_type, is_topupable, created_at)
           SELECT :key, :label, :reset_period, 'integer', 0, NOW() FROM DUAL
            WHERE NOT EXISTS (SELECT 1 FROM feature_types WHERE \`key\` = :key)`,
          { replacements: m },
        );
      }
    }

    // ---- 3. retire the per-tool AI features ----
    for (const key of RETIRED_AI) {
      const [[ft]] = await q('SELECT id FROM feature_types WHERE `key` = :key', { replacements: { key } });
      if (!ft) continue;
      const [[refs]] = await q(
        `SELECT (SELECT COUNT(*) FROM quota_packs       WHERE feature_type_id = :id)
              + (SELECT COUNT(*) FROM user_quota_grants WHERE feature_type_id = :id) AS n`,
        { replacements: { id: ft.id } },
      );
      if (Number(refs.n) > 0) {
        console.warn(`[migration 048] kept feature type '${key}': top-up packs or grants reference it`);
        continue;
      }
      await q('DELETE FROM quota_usage_events WHERE feature_type_id = :id', { replacements: { id: ft.id } });
      await q('DELETE FROM plan_features     WHERE feature_type_id = :id', { replacements: { id: ft.id } });
      await q('DELETE FROM feature_types     WHERE id = :id',              { replacements: { id: ft.id } });
    }

    const [unmetered] = await q(
      `SELECT \`key\` FROM feature_types WHERE data_type = 'integer' AND \`key\` NOT IN (:keys)`,
      { replacements: { keys: METERED } },
    );
    if (unmetered.length) {
      console.warn(
        `[migration 048] integer features nothing meters (fix or make boolean in the admin panel): ${unmetered.map((r) => r.key).join(', ')}`,
      );
    }

    // ---- 4. the free plan ----
    await queryInterface.changeColumn('plans', 'plan_type', {
      type: S.ENUM('subscription', 'access_pass', 'free'), allowNull: false, defaultValue: 'subscription',
    });

    // Convert only an unambiguous candidate: exactly one plan called "Free" that
    // nobody can buy (no active billing option). Anything else is left for an
    // admin to designate by hand.
    const [candidates] = await q(
      `SELECT p.id FROM plans p
        WHERE LOWER(p.name) = 'free' AND p.plan_type = 'subscription'
          AND NOT EXISTS (SELECT 1 FROM plan_billing_options o WHERE o.plan_id = p.id AND o.is_active = 1)`,
    );
    if (candidates.length === 1) {
      await q("UPDATE plans SET plan_type = 'free', trial_days = NULL WHERE id = :id", { replacements: { id: candidates[0].id } });
    } else if (candidates.length > 1) {
      console.warn('[migration 048] several plans named "Free" — set plan_type=free on one by hand');
    }
  },

  async down(queryInterface, Sequelize) {
    const S = Sequelize;
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);

    await q("UPDATE plans SET plan_type = 'subscription' WHERE plan_type = 'free'");
    await queryInterface.changeColumn('plans', 'plan_type', {
      type: S.ENUM('subscription', 'access_pass'), allowNull: false, defaultValue: 'subscription',
    });

    // The new meters' feature types and the retired AI features are not touched:
    // the former may hold admin-entered plan values, the latter's data is gone.

    for (const [key, column] of Object.entries(LEGACY)) {
      await queryInterface.addColumn('user_quota_usage', column, {
        type: key === 'storage' ? S.BIGINT : S.INTEGER, defaultValue: 0,
      });
      await q(
        `UPDATE user_quota_usage u
           JOIN user_quota_counters c ON c.user_id = u.user_id
           JOIN feature_types ft ON ft.id = c.feature_type_id AND ft.\`key\` = :key
            SET u.\`${column}\` = c.used`,
        { replacements: { key } },
      );
    }
    await queryInterface.dropTable('user_quota_counters');
  },
};
