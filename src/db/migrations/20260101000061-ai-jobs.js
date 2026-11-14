'use strict';

/**
 * The AI job queue and its per-attempt log, plus the AI knobs in app_settings.
 *
 *   ai_jobs — every AI spend is one row, sync or async. It is the queue too: a
 *     request inserts a `queued` row in the same transaction as the credit charge,
 *     and the worker claims it with an atomic `queued -> sending` UPDATE (no
 *     SKIP LOCKED: dev is MariaDB 10.4). The row snapshots the route, provider,
 *     model, provider units and cost per unit at send time, so margin reports stay
 *     correct after a price change or a provider switch.
 *
 *     `charge_split` records exactly where the credits came from — the plan
 *     counter share, and which top-up grant rows were debited by how much — so a
 *     refund puts them back where they came from. It lives on the job rather than
 *     being read back off quota_usage_events, which is pruned at 13 months.
 *
 *     `provider_result` is internal (result URLs that expire in minutes); it is
 *     never serialised to a client. `result` holds OUR copies in S3.
 *
 *     user_id is ON DELETE SET NULL: an account purge must not erase what the job
 *     cost us. Nullable for that reason only.
 *
 *   ai_job_attempts — one row per send to a provider. The user is charged once per
 *     job however many attempts it takes.
 *
 * No NOW() is relied on for queue timing: the code passes JS dates, because
 * Sequelize writes UTC while a local MariaDB's NOW() is IST. See 059 for the
 * portability notes.
 */
const TABLE_OPTS = { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' };

const SETTINGS = [
  ['ai_max_concurrent_jobs_per_user', '3',  'integer', 'AI jobs one user may have queued or running at once'],
  ['ai_job_timeout_minutes',          '15', 'integer', 'Minutes an AI job may run before it fails and is refunded'],
  ['ai_unknown_resolve_minutes',      '30', 'integer', 'Minutes before an AI job whose send outcome is unknown is failed and refunded'],
  ['ai_moderation_strikes_per_hour',  '5',  'integer', 'Moderation blocks per user per hour before AI requests are paused'],
  ['ai_credit_value_inr',             '',   'string',  'Rupees one MMB AI credit is worth, for the margin report (decimal)'],
  ['ai_target_margin_pct',            '50', 'integer', 'Gross margin below which the AI margin report flags a route'],
  ['ai_fx_buffer_pct',                '15', 'integer', 'Rupee weakening the AI margin projection is stressed against'],
  ['ai_spillover_wait_seconds',       '60', 'integer', 'Seconds a queued AI job waits on a busy primary before spilling to a fallback'],
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const S   = Sequelize;
    const now = S.literal('CURRENT_TIMESTAMP');
    const fk = (table, onDelete, allowNull = false) => ({
      type: S.INTEGER, allowNull,
      references: { model: table, key: 'id' }, onDelete, onUpdate: 'CASCADE',
    });

    await queryInterface.createTable('ai_jobs', {
      id:                { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      uid:               { type: S.UUID, allowNull: false, unique: true },
      user_id:           fk('users', 'SET NULL', true),
      operation_id:      fk('ai_operations', 'RESTRICT'),
      operation_key:     { type: S.STRING(60), allowNull: false },
      // queued | sending | processing | unknown | done | failed
      status:            { type: S.STRING(16), allowNull: false, defaultValue: 'queued' },
      idempotency_key:   { type: S.STRING(64), allowNull: false },
      input_hash:        { type: S.CHAR(64), allowNull: false },
      input:             { type: S.JSON, allowNull: true },

      credits_charged:   { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      charge_split:      { type: S.JSON, allowNull: true },
      refunded_at:       { type: S.DATE, allowNull: true },
      refund_split:      { type: S.JSON, allowNull: true },

      route_id:          { type: S.INTEGER, allowNull: true },
      provider_id:       { type: S.INTEGER, allowNull: true },
      model:             { type: S.STRING(100), allowNull: true },
      provider_units:    { type: S.DECIMAL(12, 4), allowNull: true },
      provider_units_actual: { type: S.DECIMAL(12, 4), allowNull: true },
      cost_per_unit_inr: { type: S.DECIMAL(14, 6), allowNull: true },
      cost_inr:          { type: S.DECIMAL(12, 4), allowNull: true },

      provider_task_id:  { type: S.STRING(128), allowNull: true },
      attempts_count:    { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      next_attempt_at:   { type: S.DATE, allowNull: true },
      claimed_by:        { type: S.STRING(120), allowNull: true },
      claimed_at:        { type: S.DATE, allowNull: true },
      sent_at:           { type: S.DATE, allowNull: true },
      last_status_check_at: { type: S.DATE, allowNull: true },
      provider_result:   { type: S.JSON, allowNull: true },
      finalizing_at:     { type: S.DATE, allowNull: true },
      completed_at:      { type: S.DATE, allowNull: true },

      error_code:        { type: S.STRING(40), allowNull: true },
      error_message:     { type: S.STRING(500), allowNull: true },
      result:            { type: S.JSON, allowNull: true },

      created_at:        { type: S.DATE, allowNull: false, defaultValue: now },
      updated_at:        { type: S.DATE, allowNull: false, defaultValue: now },
    }, TABLE_OPTS);
    // A mobile retry with the same Idempotency-Key finds the first job instead of
    // charging twice.
    await queryInterface.addIndex('ai_jobs', ['user_id', 'idempotency_key'], { unique: true, name: 'uq_ai_job_user_idem' });
    // The dispatcher's one query every few seconds.
    await queryInterface.addIndex('ai_jobs', ['status', 'next_attempt_at', 'id'], { name: 'ix_ai_job_status_next' });
    // Webhooks find their job by the provider's task id.
    await queryInterface.addIndex('ai_jobs', ['provider_id', 'provider_task_id'], { name: 'ix_ai_job_provider_task' });
    // A user's history, their in-flight cap and their moderation strikes.
    await queryInterface.addIndex('ai_jobs', ['user_id', 'created_at'], { name: 'ix_ai_job_user_recent' });

    await queryInterface.createTable('ai_job_attempts', {
      id:               { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      job_id:           fk('ai_jobs', 'CASCADE'),
      attempt_no:       { type: S.INTEGER, allowNull: false },
      route_id:         { type: S.INTEGER, allowNull: true },
      provider_id:      { type: S.INTEGER, allowNull: true },
      model:            { type: S.STRING(100), allowNull: true },
      // accepted | done | failed | unknown | requeued
      outcome:          { type: S.STRING(16), allowNull: true },
      provider_task_id: { type: S.STRING(128), allowNull: true },
      http_status:      { type: S.INTEGER, allowNull: true },
      error_code:       { type: S.STRING(40), allowNull: true },
      error_detail:     { type: S.STRING(500), allowNull: true },
      started_at:       { type: S.DATE, allowNull: false },
      finished_at:      { type: S.DATE, allowNull: true },
      duration_ms:      { type: S.INTEGER, allowNull: true },
    }, TABLE_OPTS);
    await queryInterface.addIndex('ai_job_attempts', ['job_id', 'attempt_no'], { unique: true, name: 'uq_ai_attempt_job_no' });

    // INSERT IGNORE so a re-run never clobbers a value an admin has since changed.
    // `key` and `group` are reserved words: backticked.
    for (const [key, value, type, description] of SETTINGS) {
      await queryInterface.sequelize.query(
        'INSERT IGNORE INTO app_settings (`key`, `value`, `type`, `description`, `group`, `is_public`) VALUES (?, ?, ?, ?, ?, 0)',
        { replacements: [key, value, type, description, 'ai'] },
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('app_settings', { key: SETTINGS.map(([k]) => k) }, {});
    await queryInterface.dropTable('ai_job_attempts');
    await queryInterface.dropTable('ai_jobs');
  },
};
