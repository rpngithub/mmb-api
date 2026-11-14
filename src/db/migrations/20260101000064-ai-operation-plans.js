'use strict';

const { v4: uuid } = require('uuid');

/**
 * Which plans may use an AI operation — replacing `is_premium_only` ("any paid
 * subscription"), which could not say "HD images for Elite only".
 *
 * 1. ai_operation_plans (operation_id, plan_id), unique per pair. An operation with
 *    NO rows is open to every plan, Free and the access pass included; with rows,
 *    only to those plans. Checked at submit against the user's effective plan
 *    (quota.effectivePlan), before anything is charged. A join table, not a JSON
 *    column: plans are rows with ids, and a deleted plan must drop out of every
 *    operation (CASCADE) rather than linger as a stale number.
 *
 * 2. ai_operations.is_premium_only is DROPPED. It was false on every operation
 *    created so far; anything an admin had set true must be re-entered as plans.
 *
 * 3. The two Magnific image operations, if they do not exist yet — INACTIVE, at a
 *    placeholder 1 credit (the credit unit is undecided), each with a Nano Banana
 *    Pro route:
 *      image.standard  1K   all plans
 *      image.hd        2K   Elite only (linked to every subscription plan whose
 *                           name contains "elite"; none found = a warning, and the
 *                           admin must set it before activating)
 *    Dev/test databases where the fake catalogue seeder already made these keys
 *    keep them as they are — only the Elite link is added.
 */

const IMAGE_SCHEMA = {
  fields: {
    prompt: { type: 'string', required: true, min: 3, max: 2000 },
    aspect_ratio: { type: 'enum', values: ['1:1', '4:5', '9:16', '16:9'], default: '1:1' },
    reference_images: { type: 'media_list', max: 3 },
  },
};

const IMAGE_OPS = [
  { key: 'image.standard', label: 'AI image', resolution: '1K', sort: 10 },
  { key: 'image.hd', label: 'AI image (HD)', resolution: '2K', sort: 20 },
];

module.exports = {
  IMAGE_SCHEMA, IMAGE_OPS,

  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);
    const now = S.literal('CURRENT_TIMESTAMP');

    // Every step checks whether it is already done. MySQL DDL cannot be rolled
    // back, so a run cut off half-way (a crash, a restart during migrate-on-boot)
    // leaves some of it applied; the next run must finish the job, not trip over it.
    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === 'string' ? t : t.tableName));
    const hasTable = tables.includes('ai_operation_plans');
    const indexNames = hasTable ? (await queryInterface.showIndex('ai_operation_plans')).map((i) => i.name) : [];
    const columns = await queryInterface.describeTable('ai_operations');

    if (!hasTable) await queryInterface.createTable('ai_operation_plans', {
      id: { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      operation_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'ai_operations', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      plan_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'plans', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      created_at: { type: S.DATE, allowNull: false, defaultValue: now },
    }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });
    if (!indexNames.includes('uq_ai_operation_plan')) {
      await queryInterface.addIndex('ai_operation_plans', ['operation_id', 'plan_id'], { unique: true, name: 'uq_ai_operation_plan' });
    }
    if (!indexNames.includes('ix_ai_operation_plan_plan')) {
      await queryInterface.addIndex('ai_operation_plans', ['plan_id'], { name: 'ix_ai_operation_plan_plan' });
    }

    if (columns.is_premium_only) await queryInterface.removeColumn('ai_operations', 'is_premium_only');

    const [[magnific]] = await q("SELECT id FROM ai_providers WHERE `key` = 'magnific'");
    for (const op of IMAGE_OPS) {
      // QueryTypes.INSERT resolves to [insertId, affectedRows]: 0 rows = the key existed.
      const [, affected] = await q(
        'INSERT IGNORE INTO ai_operations (uid, `key`, label, credits, unit, ledger_source, input_schema, price_rules, is_active, sort_order) ' +
        "VALUES (?, ?, ?, 1, 'image', 'image_generation', ?, ?, 0, ?)",
        { replacements: [uuid(), op.key, op.label, JSON.stringify(IMAGE_SCHEMA), JSON.stringify({}), op.sort], type: S.QueryTypes.INSERT },
      );
      const inserted = Number(affected) === 1;
      if (!inserted || !magnific) continue;
      const [[row]] = await q('SELECT id FROM ai_operations WHERE `key` = ?', { replacements: [op.key] });
      // Nano Banana Pro: 75 Magnific credits for 1K or 2K (team rate card).
      await q(
        'INSERT INTO ai_operation_routes (uid, operation_id, provider_id, model, fixed_params, provider_units, priority, weight, fallback_allowed, is_active) ' +
        "VALUES (?, ?, ?, 'nano-banana-pro', ?, 75, 100, 100, 1, 1)",
        { replacements: [uuid(), row.id, magnific.id, JSON.stringify({ resolution: op.resolution })] },
      );
    }

    const [[hd]] = await q("SELECT id FROM ai_operations WHERE `key` = 'image.hd'");
    const [elite] = await q("SELECT id FROM plans WHERE plan_type = 'subscription' AND LOWER(name) LIKE '%elite%'");
    if (hd && elite.length) {
      for (const p of elite) {
        await q('INSERT IGNORE INTO ai_operation_plans (operation_id, plan_id) VALUES (?, ?)', { replacements: [hd.id, p.id] });
      }
    } else if (hd) {
      console.warn('[migration 064] no Elite plan found — image.hd has NO plan restriction. Set its plans in the admin panel before activating it.');
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('ai_operations', 'is_premium_only', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
    // An operation that was restricted to plans comes back as premium-only.
    await queryInterface.sequelize.query('UPDATE ai_operations SET is_premium_only = 1 WHERE id IN (SELECT operation_id FROM ai_operation_plans)');
    await queryInterface.dropTable('ai_operation_plans');
    // The image operations stay: jobs may already point at them.
  },
};
