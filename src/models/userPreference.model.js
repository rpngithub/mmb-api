const { DataTypes } = require('sequelize');

// Per-user settings. Typed columns rather than a JSON blob because these are
// filtered on when sending ("everyone with email on", "send in Hindi"), not just
// rendered. The row is created lazily — see user.service#getPreferences, which
// applies DEFAULTS when a user has never saved any.
module.exports = (sequelize) => {
  const UserPreference = sequelize.define('UserPreference', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id:         { type: DataTypes.INTEGER, allowNull: false, unique: true },
    // NOTE: content language is NOT here. "Preferred Languages" is plural and
    // selects which templates are shown — see user_languages / UserLanguage.
    // Transactional channels only. Marketing consent must be its own field when
    // it lands, so a campaign can never be sent to someone who only opted into
    // receipts.
    notify_push:     { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    notify_email:    { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    notify_whatsapp: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    // The marketing consent the comment above reserved. It is a PURPOSE, not a
    // channel: every promotional notification and every campaign ANDs it, while
    // transactional sends (payment failed, trial ending) ignore it entirely, so
    // muting promos can never cost someone a receipt.
    notify_marketing: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
  }, { tableName: 'user_preferences' });

  UserPreference.associate = (models) => {
    UserPreference.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return UserPreference;
};
