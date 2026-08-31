const { DataTypes } = require('sequelize');

// The scenario a notification belongs to — "Subscription & Billing", "Retention",
// "Marketing Calendar". A table rather than an ENUM on the template, because the
// app groups the inbox by these and users mute them one at a time: both want a
// stable id, and the labels are the admin's to edit.
module.exports = (sequelize) => {
  const NotificationCategory = sequelize.define('NotificationCategory', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:          { type: DataTypes.STRING(100), allowNull: false },
    slug:          { type: DataTypes.STRING(120), allowNull: false },
    description:   { type: DataTypes.TEXT, allowNull: true },
    // A client-side glyph key ("credit-card"), not an asset — the app ships the
    // icons and the admin only chooses which one.
    icon:          { type: DataTypes.STRING(60), allowNull: true },
    display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    is_active:     { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
  }, { tableName: 'notification_categories' });

  NotificationCategory.associate = (models) => {
    NotificationCategory.hasMany(models.NotificationTemplate,     { foreignKey: 'category_id' });
    NotificationCategory.hasMany(models.UserNotification,         { foreignKey: 'category_id' });
    NotificationCategory.hasMany(models.UserNotificationSetting,  { foreignKey: 'category_id' });
  };

  return NotificationCategory;
};
