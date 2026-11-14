const { DataTypes } = require('sequelize');
const { jsonColumn } = require('../utils/jsonColumn');

// One AI spend, and the queue entry for it. See migration 20260101000061 and the
// state machine in src/ai/queue.js.
module.exports = (sequelize) => {
  const AiJob = sequelize.define('AiJob', {
    id:                { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:               { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:           { type: DataTypes.INTEGER, allowNull: true },
    operation_id:      { type: DataTypes.INTEGER, allowNull: false },
    operation_key:     { type: DataTypes.STRING(60), allowNull: false },
    status:            { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'queued' },
    idempotency_key:   { type: DataTypes.STRING(64), allowNull: false },
    input_hash:        { type: DataTypes.CHAR(64), allowNull: false },
    input:             jsonColumn('input', { allowNull: true }),
    // What the server added (ai/context.js), resolved at submit. Never sent to the app.
    context:           jsonColumn('context', { allowNull: true }),
    // What the LAST send used: route, model, prompt_version and the route's full
    // fixed_params (prompts, output schema), which admins can edit later.
    request_snapshot:  jsonColumn('request_snapshot', { allowNull: true }),

    credits_charged:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    charge_split:      jsonColumn('charge_split', { allowNull: true }),
    refunded_at:       { type: DataTypes.DATE, allowNull: true },
    refund_split:      jsonColumn('refund_split', { allowNull: true }),

    route_id:          { type: DataTypes.INTEGER, allowNull: true },
    provider_id:       { type: DataTypes.INTEGER, allowNull: true },
    model:             { type: DataTypes.STRING(100), allowNull: true },
    provider_units:    { type: DataTypes.DECIMAL(12, 4), allowNull: true },
    provider_units_actual: { type: DataTypes.DECIMAL(12, 4), allowNull: true },
    cost_per_unit_inr: { type: DataTypes.DECIMAL(14, 6), allowNull: true },
    cost_inr:          { type: DataTypes.DECIMAL(12, 4), allowNull: true },

    provider_task_id:  { type: DataTypes.STRING(128), allowNull: true },
    attempts_count:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    next_attempt_at:   { type: DataTypes.DATE, allowNull: true },
    claimed_by:        { type: DataTypes.STRING(120), allowNull: true },
    claimed_at:        { type: DataTypes.DATE, allowNull: true },
    sent_at:           { type: DataTypes.DATE, allowNull: true },
    last_status_check_at: { type: DataTypes.DATE, allowNull: true },
    provider_result:   jsonColumn('provider_result', { allowNull: true }),
    finalizing_at:     { type: DataTypes.DATE, allowNull: true },
    completed_at:      { type: DataTypes.DATE, allowNull: true },

    error_code:        { type: DataTypes.STRING(40), allowNull: true },
    error_message:     { type: DataTypes.STRING(500), allowNull: true },
    result:            jsonColumn('result', { allowNull: true }),
  }, { tableName: 'ai_jobs' });

  AiJob.associate = (models) => {
    AiJob.belongsTo(models.User,             { foreignKey: 'user_id' });
    AiJob.belongsTo(models.AiOperation,      { foreignKey: 'operation_id', as: 'operation' });
    AiJob.belongsTo(models.AiOperationRoute, { foreignKey: 'route_id',     as: 'route', constraints: false });
    AiJob.belongsTo(models.AiProvider,       { foreignKey: 'provider_id',  as: 'provider', constraints: false });
    AiJob.hasMany(models.AiJobAttempt,       { foreignKey: 'job_id',       as: 'attempts' });
  };

  return AiJob;
};
