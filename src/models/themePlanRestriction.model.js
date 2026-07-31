const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('ThemePlanRestriction', {
    id:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    theme_id: { type: DataTypes.INTEGER, allowNull: false },
    plan_id:  { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'theme_plan_restrictions', timestamps: false });
};
