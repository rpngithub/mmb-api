const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const FeatureType = sequelize.define('FeatureType', {
    id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    key:          { type: DataTypes.STRING(100), allowNull: false, unique: true },
    label:        { type: DataTypes.STRING(200), allowNull: false },
    description:  { type: DataTypes.TEXT, allowNull: true },
    reset_period: { type: DataTypes.ENUM('monthly', 'annual', 'never'), defaultValue: 'never' },
    data_type:    { type: DataTypes.ENUM('integer', 'boolean'), defaultValue: 'integer' },
    // Whether extra quota for this feature may be SOLD as a top-up pack. Opt-in
    // (default 0), because selling headroom for something nothing meters would be
    // taking money for nothing. Set for ai_credits and storage.
    is_topupable: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
  }, { tableName: 'feature_types', updatedAt: false });

  FeatureType.associate = (models) => {
    FeatureType.hasMany(models.PlanFeature,    { foreignKey: 'feature_type_id' });
    FeatureType.hasMany(models.QuotaPack,      { foreignKey: 'feature_type_id' });
    FeatureType.hasMany(models.UserQuotaGrant, { foreignKey: 'feature_type_id' });
  };

  return FeatureType;
};
