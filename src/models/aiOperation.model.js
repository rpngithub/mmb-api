const { DataTypes } = require('sequelize');
const { jsonColumn } = require('../utils/jsonColumn');

// What we sell, priced in MMB credits. No provider or model here — see
// migration 20260101000060.
module.exports = (sequelize) => {
  const AiOperation = sequelize.define('AiOperation', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    key:             { type: DataTypes.STRING(60), allowNull: false, unique: true },
    label:           { type: DataTypes.STRING(100), allowNull: false },
    description:     { type: DataTypes.STRING(500), allowNull: true },
    credits:         { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    unit:            { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'call' },
    ledger_source:   { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'image_generation' },
    input_schema:    jsonColumn('input_schema', { allowNull: true }),
    price_rules:     jsonColumn('price_rules', { allowNull: true }),
    is_active:       { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sort_order:      { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, { tableName: 'ai_operations' });

  AiOperation.associate = (models) => {
    AiOperation.hasMany(models.AiOperationRoute, { foreignKey: 'operation_id', as: 'routes' });
    // The plans allowed to use it; none = every plan (migration 064).
    AiOperation.belongsToMany(models.Plan, {
      through: models.AiOperationPlan, foreignKey: 'operation_id', otherKey: 'plan_id', as: 'plans',
    });
  };

  return AiOperation;
};
