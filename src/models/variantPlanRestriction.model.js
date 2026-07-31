const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('VariantPlanRestriction', {
    id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    variant_id: { type: DataTypes.INTEGER, allowNull: false },
    plan_id:    { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'variant_plan_restrictions', timestamps: false });
};
