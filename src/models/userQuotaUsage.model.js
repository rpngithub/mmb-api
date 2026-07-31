const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UserQuotaUsage = sequelize.define('UserQuotaUsage', {
    id:                   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id:              { type: DataTypes.INTEGER, allowNull: false, unique: true },
    storage_used_bytes:   { type: DataTypes.BIGINT, defaultValue: 0 },
    ai_credits_used:      { type: DataTypes.INTEGER, defaultValue: 0 },
    downloads_count:      { type: DataTypes.INTEGER, defaultValue: 0 },
    shares_count:         { type: DataTypes.INTEGER, defaultValue: 0 },
    template_views_count: { type: DataTypes.INTEGER, defaultValue: 0 },
    period_start:         { type: DataTypes.DATEONLY, allowNull: true },
    period_end:           { type: DataTypes.DATEONLY, allowNull: true },
  }, { tableName: 'user_quota_usage', createdAt: false });

  UserQuotaUsage.associate = (models) => {
    UserQuotaUsage.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return UserQuotaUsage;
};
