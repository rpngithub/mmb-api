const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const User = sequelize.define('User', {
    id:                   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:                  { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:                 { type: DataTypes.STRING(100), allowNull: false },
    email:                { type: DataTypes.STRING(255), unique: true, allowNull: true },
    phone:                { type: DataTypes.STRING(20), unique: true, allowNull: true },
    password_hash:        { type: DataTypes.STRING(255), allowNull: true },
    profile_photo_s3_key: { type: DataTypes.STRING(500), allowNull: true },
    razorpay_customer_id: { type: DataTypes.STRING(100), allowNull: true },
    is_active:            { type: DataTypes.TINYINT, defaultValue: 1 },
    last_login_at:        { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'users' });

  User.associate = (models) => {
    User.hasMany(models.Business,         { foreignKey: 'user_id' });
    User.hasMany(models.UserSession,      { foreignKey: 'actor_id', scope: { actor_type: 'user' }, constraints: false });
    User.hasMany(models.TokenBlacklist,   { foreignKey: 'actor_id', scope: { actor_type: 'user' }, constraints: false });
    User.hasOne(models.UserQuotaUsage,    { foreignKey: 'user_id' });
    User.hasOne(models.UserBillingDetail, { foreignKey: 'user_id' });
    User.hasMany(models.UserSubscription, { foreignKey: 'user_id' });
    User.hasMany(models.Project,          { foreignKey: 'user_id' });
  };

  return User;
};
