const { DataTypes } = require('sequelize');

// One metered feature's usage for one user: `used` in COUNTER units (bytes for
// storage, 1 per action elsewhere). Replaces the per-meter columns that used to
// live on user_quota_usage, so a new meter needs a code entry in
// src/constants/quotaMeters.js rather than a migration. The usage WINDOW stays on
// user_quota_usage — it is one date for the whole account, not per feature.
module.exports = (sequelize) => {
  const UserQuotaCounter = sequelize.define('UserQuotaCounter', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id:         { type: DataTypes.INTEGER, allowNull: false },
    feature_type_id: { type: DataTypes.INTEGER, allowNull: false },
    used:            { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  }, { tableName: 'user_quota_counters' });

  UserQuotaCounter.associate = (models) => {
    UserQuotaCounter.belongsTo(models.User,        { foreignKey: 'user_id' });
    UserQuotaCounter.belongsTo(models.FeatureType, { foreignKey: 'feature_type_id' });
  };

  return UserQuotaCounter;
};
