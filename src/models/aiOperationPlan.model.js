const { DataTypes } = require('sequelize');

// AI operation <-> plan: the plans allowed to use an operation. No rows for an
// operation = every plan. See migration 20260101000064.
module.exports = (sequelize) => {
  const AiOperationPlan = sequelize.define('AiOperationPlan', {
    id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    operation_id: { type: DataTypes.INTEGER, allowNull: false },
    plan_id:      { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'ai_operation_plans', updatedAt: false });

  return AiOperationPlan;
};
