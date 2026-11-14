const { DataTypes } = require('sequelize');

// One send of an AI job to a provider. See migration 20260101000061.
module.exports = (sequelize) => {
  const AiJobAttempt = sequelize.define('AiJobAttempt', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    job_id:           { type: DataTypes.INTEGER, allowNull: false },
    attempt_no:       { type: DataTypes.INTEGER, allowNull: false },
    route_id:         { type: DataTypes.INTEGER, allowNull: true },
    provider_id:      { type: DataTypes.INTEGER, allowNull: true },
    model:            { type: DataTypes.STRING(100), allowNull: true },
    outcome:          { type: DataTypes.STRING(16), allowNull: true },
    provider_task_id: { type: DataTypes.STRING(128), allowNull: true },
    http_status:      { type: DataTypes.INTEGER, allowNull: true },
    error_code:       { type: DataTypes.STRING(40), allowNull: true },
    error_detail:     { type: DataTypes.STRING(500), allowNull: true },
    started_at:       { type: DataTypes.DATE, allowNull: false },
    finished_at:      { type: DataTypes.DATE, allowNull: true },
    duration_ms:      { type: DataTypes.INTEGER, allowNull: true },
    // Only when the provider's settings.capture_responses is on: a short excerpt
    // of the provider's raw response body (never request headers, so never the
    // key). See migration 20260101000062.
    response_excerpt: { type: DataTypes.TEXT, allowNull: true },
  }, { tableName: 'ai_job_attempts', timestamps: false });

  AiJobAttempt.associate = (models) => {
    AiJobAttempt.belongsTo(models.AiJob, { foreignKey: 'job_id', as: 'job' });
  };

  return AiJobAttempt;
};
