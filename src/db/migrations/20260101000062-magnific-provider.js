'use strict';

const { v4: uuid } = require('uuid');

/**
 * Magnific, as a provider row — DISABLED.
 *
 * The adapter (src/ai/providers/magnific.js) ships with this release, but nothing
 * is sent to Magnific until an admin has entered and verified a key, created the
 * operations and routes (prices wait on the credit-unit decision), and set the
 * provider to `active`. So this inserts no operations and no routes.
 *
 * rate_limit_rpm 45: the team's guide says Premium+ is 50 requests/min for the
 * whole account, status checks included; the public docs say 30,000/min per key.
 * Until the account's real limit is confirmed, the conservative one stands — it is
 * an admin setting either way.
 *
 * settings:
 *   webhook_secret_encoding  auto | raw | base64 — Magnific's own examples disagree
 *                            (JS/Python use the secret raw, PHP base64-decodes it);
 *                            `auto` accepts a signature made either way.
 *   capture_responses        when true, each attempt keeps a short excerpt of the
 *                            provider's raw response (ai_job_attempts.response_excerpt)
 *                            — for the first live calls, to check the shapes the
 *                            adapter assumes. Off by default.
 *
 * Also adds ai_job_attempts.response_excerpt (TEXT, nullable — portable as is).
 * INSERT IGNORE on the unique `key`, so a re-run never overwrites what an admin
 * has since changed.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('ai_job_attempts', 'response_excerpt', { type: Sequelize.TEXT, allowNull: true });

    await queryInterface.sequelize.query(
      'INSERT IGNORE INTO ai_providers (uid, `key`, name, status, base_url, credential_source, rate_limit_rpm, max_concurrency, timeout_ms, cost_unit, settings, terms_url) ' +
      "VALUES (?, 'magnific', 'Magnific', 'disabled', 'https://api.magnific.com', 'db', 45, 10, 30000, 'credit', ?, ?)",
      {
        replacements: [
          uuid(),
          JSON.stringify({ webhook_secret_encoding: 'auto', capture_responses: false }),
          'https://www.magnific.com/legal/terms-of-use#api-services',
        ],
      },
    );
  },

  async down(queryInterface) {
    // The row goes only if nothing hangs off it yet.
    await queryInterface.sequelize.query(
      "DELETE FROM ai_providers WHERE `key` = 'magnific' " +
      'AND id NOT IN (SELECT provider_id FROM ai_operation_routes) ' +
      'AND id NOT IN (SELECT provider_id FROM ai_provider_credentials) ' +
      'AND id NOT IN (SELECT provider_id FROM ai_jobs WHERE provider_id IS NOT NULL)',
    );
    await queryInterface.removeColumn('ai_job_attempts', 'response_excerpt');
  },
};
