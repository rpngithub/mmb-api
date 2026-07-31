const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PlanFeature = sequelize.define('PlanFeature', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    plan_id:         { type: DataTypes.INTEGER, allowNull: false },
    feature_type_id: { type: DataTypes.INTEGER, allowNull: false },
    value:           { type: DataTypes.INTEGER, allowNull: false, comment: '-1 = unlimited' },
    display_label:   { type: DataTypes.STRING(200), allowNull: true },
    display_order:   { type: DataTypes.INTEGER, defaultValue: 0 },
    show_on_card:    { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'plan_features', timestamps: false });

  PlanFeature.associate = (models) => {
    PlanFeature.belongsTo(models.Plan,        { foreignKey: 'plan_id' });
    PlanFeature.belongsTo(models.FeatureType, { foreignKey: 'feature_type_id' });
  };

  return PlanFeature;
};
