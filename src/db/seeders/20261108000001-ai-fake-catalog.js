'use strict';

const { v4: uuid } = require('uuid');

// A working AI catalogue for dev and tests, every route on the `fake` adapter —
// which returns an in-code PNG and never touches the network or a real provider's
// rate limit. Credits here are PLACEHOLDERS: the MMB credit unit is still
// undecided, and real prices are entered from the admin panel.
//
// Never runs in production: there the catalogue is admin-entered, and the fake
// adapter is refused at boot anyway (src/ai/providers/index.js).
//
// Resolved by natural key throughout (INSERT IGNORE + SELECT by key) — the test
// database persists between runs and a hardcoded id would eventually collide.

const PROMPT = { type: 'string', required: true, min: 3, max: 2000 };
const ASPECT = { type: 'enum', values: ['1:1', '4:5', '9:16', '16:9'], default: '1:1' };

const OPERATIONS = [
  {
    key: 'image.standard', label: 'AI image', credits: 1, unit: 'image', ledger_source: 'image_generation', sort_order: 10,
    input_schema: { fields: {
      prompt: PROMPT, aspect_ratio: ASPECT,
      num_images: { type: 'integer', min: 1, max: 4, default: 1 },
      reference_images: { type: 'media_list', max: 3 },
    } },
    price_rules: { units_from: 'num_images' },
    route: { model: 'fake-image', fixed_params: { mode: 'async', resolution: '2k' }, provider_units: 75 },
  },
  {
    key: 'image.hd', label: 'AI image (HD)', credits: 2, unit: 'image', ledger_source: 'image_generation', sort_order: 20,
    input_schema: { fields: {
      prompt: PROMPT, aspect_ratio: ASPECT,
      num_images: { type: 'integer', min: 1, max: 4, default: 1 },
      reference_images: { type: 'media_list', max: 3 },
    } },
    price_rules: { units_from: 'num_images' },
    route: { model: 'fake-image', fixed_params: { mode: 'async', resolution: '4k' }, provider_units: 150 },
  },
  {
    key: 'product.background', label: 'Product background', credits: 1, unit: 'image', ledger_source: 'image_edit', sort_order: 30,
    input_schema: { fields: {
      prompt: PROMPT, aspect_ratio: ASPECT,
      product_image: { type: 'media', required: true },
    } },
    price_rules: {},
    route: { model: 'fake-image', fixed_params: { mode: 'async' }, provider_units: 75, fallback_allowed: false },
  },
  {
    key: 'poster.text', label: 'Poster with text', credits: 2, unit: 'image', ledger_source: 'image_generation', sort_order: 40,
    input_schema: { fields: {
      prompt: PROMPT, aspect_ratio: ASPECT,
      quality: { type: 'enum', values: ['low', 'medium', 'high'], default: 'medium' },
    } },
    price_rules: { multipliers: { quality: { low: 1, medium: 1, high: 2 } } },
    route: { model: 'fake-image', fixed_params: { mode: 'async' }, provider_units: 30 },
  },
  {
    key: 'bg_remove', label: 'Remove background', credits: 1, unit: 'call', ledger_source: 'background_removal', sort_order: 50,
    input_schema: { fields: { image: { type: 'media', required: true } } },
    price_rules: {},
    route: { model: 'fake-bg-remove', fixed_params: { mode: 'sync' }, provider_units: 25 },
  },
];

module.exports = {
  async up(queryInterface) {
    if (process.env.NODE_ENV === 'production') return;
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements });

    await q(
      'INSERT IGNORE INTO ai_providers (uid, `key`, name, status, base_url, credential_source, rate_limit_rpm, max_concurrency, timeout_ms, cost_per_unit_inr) ' +
      "VALUES (?, 'fake', 'Fake (dev/test)', 'active', NULL, 'db', 600, 50, 5000, 0.0757)",
      [uuid()],
    );
    const [[provider]] = await q("SELECT id FROM ai_providers WHERE `key` = 'fake'");

    for (const op of OPERATIONS) {
      await q(
        'INSERT IGNORE INTO ai_operations (uid, `key`, label, credits, unit, ledger_source, input_schema, price_rules, is_active, sort_order) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
        [uuid(), op.key, op.label, op.credits, op.unit, op.ledger_source,
          JSON.stringify(op.input_schema), JSON.stringify(op.price_rules), op.sort_order],
      );
      const [[row]] = await q('SELECT id FROM ai_operations WHERE `key` = ?', [op.key]);
      const [[existing]] = await q('SELECT id FROM ai_operation_routes WHERE operation_id = ? AND provider_id = ?', [row.id, provider.id]);
      if (existing) continue;
      await q(
        'INSERT INTO ai_operation_routes (uid, operation_id, provider_id, model, fixed_params, provider_units, priority, weight, fallback_allowed, is_active) ' +
        'VALUES (?, ?, ?, ?, ?, ?, 100, 100, ?, 1)',
        [uuid(), row.id, provider.id, op.route.model, JSON.stringify(op.route.fixed_params),
          op.route.provider_units, op.route.fallback_allowed === false ? 0 : 1],
      );
    }
  },

  async down(queryInterface) {
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements });
    const keys = OPERATIONS.map((o) => o.key);
    const [[provider]] = await q("SELECT id FROM ai_providers WHERE `key` = 'fake'");
    if (!provider) return;
    await q('DELETE FROM ai_operation_routes WHERE provider_id = ?', [provider.id]);
    // Operations a job has used are kept (ai_jobs pins them with RESTRICT).
    await q('DELETE FROM ai_operations WHERE `key` IN (?) AND id NOT IN (SELECT operation_id FROM ai_jobs)', [keys]);
    await q('DELETE FROM ai_providers WHERE id = ? AND id NOT IN (SELECT provider_id FROM ai_operation_routes)', [provider.id]);
  },
};
