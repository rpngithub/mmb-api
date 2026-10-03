const { DataTypes } = require('sequelize');

// The account's usage WINDOW — the single "Everything resets on …" date. The
// counters themselves live in user_quota_counters, one row per feature.
module.exports = (sequelize) => {
  const UserQuotaUsage = sequelize.define('UserQuotaUsage', {
    id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id:      { type: DataTypes.INTEGER, allowNull: false, unique: true },
    period_start: { type: DataTypes.DATEONLY, allowNull: true },
    period_end:   { type: DataTypes.DATEONLY, allowNull: true },
  }, { tableName: 'user_quota_usage', createdAt: false });

  UserQuotaUsage.associate = (models) => {
    UserQuotaUsage.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return UserQuotaUsage;
};
