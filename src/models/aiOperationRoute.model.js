const { DataTypes } = require('sequelize');
const { jsonColumn } = require('../utils/jsonColumn');

// Who fulfils an operation, and at what cost to us. See migration 20260101000060.
module.exports = (sequelize) => {
  const AiOperationRoute = sequelize.define('AiOperationRoute', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    operation_id:     { type: DataTypes.INTEGER, allowNull: false },
    provider_id:      { type: DataTypes.INTEGER, allowNull: false },
    model:            { type: DataTypes.STRING(100), allowNull: false },
    fixed_params:     jsonColumn('fixed_params', { allowNull: true }),
    provider_units:   { type: DataTypes.DECIMAL(12, 4), allowNull: false, defaultValue: 0 },
    priority:         { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
    weight:           { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
    fallback_allowed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    max_cost_inr:     { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    is_active:        { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, { tableName: 'ai_operation_routes' });

  AiOperationRoute.associate = (models) => {
    AiOperationRoute.belongsTo(models.AiOperation, { foreignKey: 'operation_id', as: 'operation' });
    AiOperationRoute.belongsTo(models.AiProvider,  { foreignKey: 'provider_id',  as: 'provider' });
  };

  return AiOperationRoute;
};
