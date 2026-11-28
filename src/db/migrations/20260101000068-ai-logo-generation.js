'use strict';

const { v4: uuid } = require('uuid');

/**
 * AI Dev Kit, feature 02 — logo generation (`logo.generate`).
 *
 * Two logo options from ONE Magnific request, on GPT image (`gpt-image-2-5`, the
 * only Magnific GPT model that returns more than one image per request).
 *
 *   The app sends: company_name (required), tagline, auto_tagline (default true),
 *                  logo_type, logo_style, colour_preference (required; free text
 *                  until the team settles lists for them).
 *   The server adds: the business's industry (required — refused with a 400, before
 *                  any charge, when the business has none), the MMB logo prompt,
 *                  the count (2) and the image settings.
 *   Tagline: a tagline the user typed is used as written; with none,
 *            auto_tagline true asks for an industry-relevant one, false for none.
 *
 * The operation is seeded INACTIVE at a placeholder 1 credit (flat: one price for
 * the two options); an admin sets the price and plans, then activates it. The route
 * goes on the existing `magnific` provider (migration 062) and is active, so the
 * operation works as soon as it is switched on. provider_units is a PLACEHOLDER
 * (the gpt-image-2-5 price per request is not yet known) — set the real one from
 * the first staging call.
 *
 * The prompt is admin data from here on: edit it on the route, not in code.
 * INSERT IGNORE / existence checks: a re-run never overwrites an admin's changes.
 */

const KEY = 'logo.generate';
const MODEL = 'gpt-image-2-5';

const INPUT_SCHEMA = {
  fields: {
    company_name:      { type: 'string', required: true, min: 1, max: 60 },
    tagline:           { type: 'string', max: 80 },
    auto_tagline:      { type: 'boolean', default: true },
    logo_type:         { type: 'string', required: true, min: 1, max: 100 },
    logo_style:        { type: 'string', required: true, min: 1, max: 100 },
    colour_preference: { type: 'string', required: true, min: 1, max: 100 },
  },
  context: ['business'],
  context_rules: { need_subject: false, need_industry: true },
};

const PROMPT_TEMPLATE = [
  'Design a professional business logo for "{{company_name}}", a {{industry}} business.',
  'Logo type: {{logo_type}}. Style: {{logo_style}}. Colours: {{colour_preference}}.',
  '{{?tagline}}Include this tagline exactly as written: "{{tagline}}".{{/tagline}}'
    + '{{^tagline}}{{?auto_tagline}}Add a short, memorable tagline that suits a {{industry}} business.{{/auto_tagline}}'
    + '{{^auto_tagline}}Do not add a tagline or any text other than the company name.{{/auto_tagline}}{{/tagline}}',
  'Keep the design simple and clean, with a clear visual identity that suits the company and works for commercial branding:',
  'signboards, packaging, business cards and social media. Avoid unnecessarily complicated details, photographic elements and mock-up scenes.',
  'Spell the company name exactly as given. Show one logo, centred on a plain background.',
].join('\n');

// gpt-image-2-5 on Magnific. Quality is always sent explicitly (Magnific's default
// is the most expensive tier); all of these are admin choices.
const FIXED_PARAMS = {
  prompt_template: PROMPT_TEMPLATE,
  num_images: 2,
  quality: 'medium',
  resolution: '1k',
  background: 'auto',
  output_format: 'png',
};
const PROVIDER_UNITS = 30;   // PLACEHOLDER: 2 images × 15 (the team's GPT image low 1K rate)

module.exports = {
  KEY, MODEL, INPUT_SCHEMA, PROMPT_TEMPLATE, FIXED_PARAMS,

  async up(queryInterface) {
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);

    await q(
      'INSERT IGNORE INTO ai_operations (uid, `key`, label, description, credits, unit, ledger_source, input_schema, price_rules, is_active, sort_order) ' +
      "VALUES (?, ?, 'AI logo', ?, 1, 'image', 'logo_generation', ?, ?, 0, 60)",
      { replacements: [uuid(), KEY, 'Two logo options for your business, from its name, style and colours.', JSON.stringify(INPUT_SCHEMA), JSON.stringify({})] },
    );
    const [[op]] = await q('SELECT id FROM ai_operations WHERE `key` = ?', { replacements: [KEY] });
    const [[magnific]] = await q("SELECT id FROM ai_providers WHERE `key` = 'magnific'");
    if (!op || !magnific) {
      if (!magnific) console.warn('[migration 068] no magnific provider — logo.generate has no route. Add one in the admin panel.');
      return;
    }
    const [[has]] = await q('SELECT COUNT(*) AS n FROM ai_operation_routes WHERE operation_id = ? AND provider_id = ?', { replacements: [op.id, magnific.id] });
    if (Number(has.n)) return;
    await q(
      'INSERT INTO ai_operation_routes (uid, operation_id, provider_id, model, fixed_params, provider_units, priority, weight, fallback_allowed, is_active) ' +
      'VALUES (?, ?, ?, ?, ?, ?, 100, 100, 1, 1)',
      { replacements: [uuid(), op.id, magnific.id, MODEL, JSON.stringify(FIXED_PARAMS), PROVIDER_UNITS] },
    );
  },

  async down(queryInterface) {
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);
    // Only while no job has used it (ai_jobs pins operations with RESTRICT).
    await q(
      'DELETE r FROM ai_operation_routes r JOIN ai_operations o ON o.id = r.operation_id ' +
      'WHERE o.`key` = ? AND o.id NOT IN (SELECT operation_id FROM ai_jobs)',
      { replacements: [KEY] },
    );
    await q(
      'DELETE FROM ai_operations WHERE `key` = ? AND id NOT IN (SELECT operation_id FROM ai_jobs) ' +
      'AND id NOT IN (SELECT operation_id FROM ai_operation_routes)',
      { replacements: [KEY] },
    );
  },
};
