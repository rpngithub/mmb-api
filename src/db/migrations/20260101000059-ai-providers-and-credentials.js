'use strict';

/**
 * AI providers, their encrypted credentials, and what we paid them.
 *
 *   ai_providers — one row per provider we can send work to. `key` must match a
 *     code adapter in src/ai/providers (the same guard quotaMeters.js gives
 *     feature types), so a row can never name a provider the code cannot talk to.
 *     Base URL, rate limit and timeout are settings, not secrets, and are
 *     admin-editable. `cost_per_unit_inr` is a CACHE derived from
 *     provider_credit_purchases, never typed in.
 *
 *   ai_provider_credentials — API keys and webhook secrets, AES-256-GCM encrypted
 *     with AI_SECRETS_MASTER_KEY (env). The database only ever holds ciphertext:
 *     a dump, a backup or a staging restore exposes nothing usable without the
 *     master key. `last4` is the only part ever shown. Rotation is
 *     pending -> active -> retired, so a new key can be verified before it is used.
 *
 *   provider_credit_purchases — what we actually paid for provider credits, from
 *     the card statement (incl. bank forex markup and GST). Cost per provider unit
 *     is derived from these rows instead of tracking a live exchange rate.
 *
 * Portability (MariaDB 10.4 / 11.8, MySQL 8): no ENUMs (status values are VARCHAR
 * checked in code), no generated columns, and an explicit utf8mb4_unicode_ci
 * collation — MariaDB 11.8 would otherwise default to utf8mb4_uca1400_ai_ci,
 * which a MySQL 8 import rejects.
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
    const providerId = {
      type: S.INTEGER, allowNull: false,
      references: { model: 'ai_providers', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
    };

    await queryInterface.createTable('ai_providers', {
      id:                { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid:               { type: S.UUID, allowNull: false, unique: true },
      key:               { type: S.STRING(40), allowNull: false, unique: true },
      name:              { type: S.STRING(100), allowNull: false },
      // active | disabled
      status:            { type: S.STRING(16), allowNull: false, defaultValue: 'disabled' },
      base_url:          { type: S.STRING(255), allowNull: true },
      // db (default) | env — env reads AI_PROVIDER_<KEY>_API_KEY, for local dev and
      // first boot before an admin has entered a key.
      credential_source: { type: S.STRING(8), allowNull: false, defaultValue: 'db' },
      rate_limit_rpm:    { type: S.INTEGER, allowNull: false, defaultValue: 45 },
      max_concurrency:   { type: S.INTEGER, allowNull: false, defaultValue: 10 },
      timeout_ms:        { type: S.INTEGER, allowNull: false, defaultValue: 30000 },
      cost_unit:         { type: S.STRING(20), allowNull: false, defaultValue: 'credit' },
      cost_per_unit_inr: { type: S.DECIMAL(14, 6), allowNull: true },
      cost_updated_at:   { type: S.DATE, allowNull: true },
      settings:          { type: S.JSON, allowNull: true },
      terms_url:         { type: S.STRING(500), allowNull: true },
      notes:             { type: S.TEXT, allowNull: true },
      ...timestamps,
    }, TABLE_OPTS);

    await queryInterface.createTable('ai_provider_credentials', {
      id:                 { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid:                { type: S.UUID, allowNull: false, unique: true },
      provider_id:        providerId,
      // api_key | webhook_secret
      kind:               { type: S.STRING(20), allowNull: false },
      ciphertext:         { type: S.BLOB, allowNull: false },
      iv:                 { type: S.BLOB, allowNull: false },
      auth_tag:           { type: S.BLOB, allowNull: false },
      master_key_version: { type: S.SMALLINT, allowNull: false, defaultValue: 1 },
      last4:              { type: S.STRING(8), allowNull: true },
      // pending | active | retired
      status:             { type: S.STRING(10), allowNull: false, defaultValue: 'pending' },
      created_by:         { type: S.INTEGER, allowNull: true },
      activated_at:       { type: S.DATE, allowNull: true },
      retired_at:         { type: S.DATE, allowNull: true },
      ...timestamps,
    }, TABLE_OPTS);
    await queryInterface.addIndex('ai_provider_credentials', ['provider_id', 'kind', 'status'], { name: 'ix_ai_cred_provider_kind_status' });

    await queryInterface.createTable('provider_credit_purchases', {
      id:               { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid:              { type: S.UUID, allowNull: false, unique: true },
      provider_id:      providerId,
      purchased_at:     { type: S.DATE, allowNull: false },
      credits_received: { type: S.DECIMAL(16, 4), allowNull: false },
      amount_paid_inr:  { type: S.DECIMAL(14, 2), allowNull: false },
      amount_foreign:   { type: S.DECIMAL(14, 2), allowNull: true },
      currency:         { type: S.CHAR(3), allowNull: true },
      note:             { type: S.STRING(255), allowNull: true },
      created_by:       { type: S.INTEGER, allowNull: true },
      ...timestamps,
    }, TABLE_OPTS);
    await queryInterface.addIndex('provider_credit_purchases', ['provider_id', 'purchased_at'], { name: 'ix_ai_purchase_provider_date' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('provider_credit_purchases');
    await queryInterface.dropTable('ai_provider_credentials');
    await queryInterface.dropTable('ai_providers');
  },
};
