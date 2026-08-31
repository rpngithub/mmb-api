const { DataTypes } = require('sequelize');

// Per-category mute — "stop sending me Marketing Calendar reminders".
//
// A row exists only when a user has turned something OFF; absent means enabled.
// Same lazy convention user.service#getPreferences already uses for
// user_preferences, so shipping this needs no backfill and costs nothing for the
// overwhelming majority of users who never touch it.
//
// This is deliberately NOT on user_preferences: that table holds CHANNEL consent
// (push/email/whatsapp/marketing) as typed columns, and per-category mutes are a
// growing set keyed on another table's id.
module.exports = (sequelize) => {
  const UserNotificationSetting = sequelize.define('UserNotificationSetting', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id:     { type: DataTypes.INTEGER, allowNull: false },
    category_id: { type: DataTypes.INTEGER, allowNull: false },
    // One column today because in-app is the only channel. Push and email get their
    // own columns here when they land, alongside the template's `channels`.
    in_app:      { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
  }, { tableName: 'user_notification_settings' });

  UserNotificationSetting.associate = (models) => {
    UserNotificationSetting.belongsTo(models.User,                 { foreignKey: 'user_id' });
    UserNotificationSetting.belongsTo(models.NotificationCategory, { foreignKey: 'category_id' });
  };

  return UserNotificationSetting;
};
