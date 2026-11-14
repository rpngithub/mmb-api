'use strict';

/**
 * What we sell, and who fulfils it.
 *
 *   ai_operations — the SELL side. `key` is the stable id the app calls
 *     (POST /ai/operations/{key}) and the job records; `credits` is what one unit
 *     costs the user in MMB credits. No provider or model fields: switching
 *     provider must never change a user's price, the app, or this row.
 *     `input_schema` is our own parameters (prompt, aspect ratio, reference
 *     images…); `price_rules` turns the parameters that change the price
 *     (num_images, quality, resolution) into units and multipliers, so the server
 *     computes the charge and never trusts a number from the client.
 *
 *   ai_operation_routes — the BUY side. Each operation has an ordered list of
 *     routes; the worker picks one at SEND time. `fixed_params` is what our
 *     "standard" means on that provider (e.g. 2K), `provider_units` what one call
 *     costs us there. Jobs snapshot both, so editing a route in place never
 *     rewrites past margins.
 *
 * RESTRICT on both FKs: an operation or provider with routes is deactivated, not
 * deleted. See 059 for the portability notes.
 */
const TABLE_OPTS = { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' };

module.exports = {
  async up(queryInterface, Sequelize) {
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');
    const timestamps = {
      created_at: { type: S.DATE, allowNull: false, defaultValue: now },
      updated_at: { type: S.DATE, allowNull: false, defaultValue: now },
    };

    await queryInterface.createTable('ai_operations', {
      id:              { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid:             { type: S.UUID, allowNull: false, unique: true },
      key:             { type: S.STRING(60), allowNull: false, unique: true },
      label:           { type: S.STRING(100), allowNull: false },
      description:     { type: S.STRING(500), allowNull: true },
      credits:         { type: S.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      // call | image
      unit:            { type: S.STRING(16), allowNull: false, defaultValue: 'call' },
      // A key of src/constants/quotaSources.js whose feature is ai_credits.
      ledger_source:   { type: S.STRING(40), allowNull: false, defaultValue: 'image_generation' },
      input_schema:    { type: S.JSON, allowNull: true },
      price_rules:     { type: S.JSON, allowNull: true },
      is_active:       { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      is_premium_only: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      sort_order:      { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      ...timestamps,
    }, TABLE_OPTS);

    await queryInterface.createTable('ai_operation_routes', {
      id:               { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid:              { type: S.UUID, allowNull: false, unique: true },
      operation_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'ai_operations', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      provider_id: {
        type: S.INTEGER, allowNull: false,
        references: { model: 'ai_providers', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      model:            { type: S.STRING(100), allowNull: false },
      fixed_params:     { type: S.JSON, allowNull: true },
      provider_units:   { type: S.DECIMAL(12, 4), allowNull: false, defaultValue: 0 },
      priority:         { type: S.INTEGER, allowNull: false, defaultValue: 100 },
      weight:           { type: S.INTEGER, allowNull: false, defaultValue: 100 },
      fallback_allowed: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      max_cost_inr:     { type: S.DECIMAL(10, 2), allowNull: true },
      is_active:        { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      ...timestamps,
    }, TABLE_OPTS);
    await queryInterface.addIndex('ai_operation_routes', ['operation_id', 'is_active', 'priority'], { name: 'ix_ai_route_op_active_priority' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ai_operation_routes');
    await queryInterface.dropTable('ai_operations');
  },
};
