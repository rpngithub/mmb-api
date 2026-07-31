const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const FeatureType = sequelize.define('FeatureType', {
    id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    key:          { type: DataTypes.STRING(100), allowNull: false, unique: true },
    label:        { type: DataTypes.STRING(200), allowNull: false },
    description:  { type: DataTypes.TEXT, allowNull: true },
    reset_period: { type: DataTypes.ENUM('monthly', 'annual', 'never'), defaultValue: 'never' },
    data_type:    { type: DataTypes.ENUM('integer', 'boolean'), defaultValue: 'integer' },
  }, { tableName: 'feature_types', updatedAt: false });

  FeatureType.associate = (models) => {
    FeatureType.hasMany(models.PlanFeature, { foreignKey: 'feature_type_id' });
  };

  return FeatureType;
};
