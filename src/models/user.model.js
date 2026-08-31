const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const User = sequelize.define('User', {
    id:                   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:                  { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:                 { type: DataTypes.STRING(100), allowNull: false },
    email:                { type: DataTypes.STRING(255), unique: true, allowNull: true },
    phone:                { type: DataTypes.STRING(20), unique: true, allowNull: true },
    password_hash:        { type: DataTypes.STRING(255), allowNull: true },
    // "What brings you here?" — a BUSINESS account continues into the industry
    // picker and owns a business; a PERSONAL account skips all of that and has no
    // business row. NULL = not answered yet, i.e. onboarding hasn't started.
    account_type:         { type: DataTypes.ENUM('business', 'personal'), allowNull: true, defaultValue: null },
    // Stamped when the flow finishes (immediately for PERSONAL, on business
    // creation for BUSINESS). Freezes `account_type` — see user.service.
    onboarding_completed_at: { type: DataTypes.DATE, allowNull: true },
    profile_photo_s3_key: { type: DataTypes.STRING(500), allowNull: true },
    razorpay_customer_id: { type: DataTypes.STRING(100), allowNull: true },
    is_active:            { type: DataTypes.TINYINT, defaultValue: 1 },
    last_login_at:        { type: DataTypes.DATE, allowNull: true },
    // Distinct from `last_login_at`, which moves once per sign-in — and a refresh
    // token lives 30 days, so someone who opens the app daily logs in about once a
    // month. Dormancy measured off login would call a daily-active user dormant,
    // which is exactly what the retention notifications must not do. Stamped by
    // middlewares/touchActivity, throttled to one write per user per 15 minutes.
    last_active_at:       { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'users' });

  User.associate = (models) => {
    User.hasMany(models.Business,         { foreignKey: 'user_id' });
    User.hasMany(models.UserSession,      { foreignKey: 'actor_id', scope: { actor_type: 'user' }, constraints: false });
    User.hasMany(models.TokenBlacklist,   { foreignKey: 'actor_id', scope: { actor_type: 'user' }, constraints: false });
    User.hasOne(models.UserQuotaUsage,    { foreignKey: 'user_id' });
    User.hasOne(models.UserBillingDetail, { foreignKey: 'user_id' });
    User.hasMany(models.UserSubscription, { foreignKey: 'user_id' });
    User.hasMany(models.Project,          { foreignKey: 'user_id' });
    User.hasOne(models.UserPreference,    { foreignKey: 'user_id' });
    User.hasMany(models.UserNotification, { foreignKey: 'user_id' });
    User.hasMany(models.UserNotificationSetting, { foreignKey: 'user_id' });
    // "Preferred Languages" — which templates this user is shown.
    User.belongsToMany(models.Language,   { through: models.UserLanguage, foreignKey: 'user_id' });
  };

  return User;
};
