const { DataTypes } = require('sequelize');

// An OTP issued to a signed-in USER, as opposed to `otp_codes`, which is keyed by
// phone because login has no user yet. Used wherever an OTP must prove something
// about one particular account: changing its phone number or its verified email.
module.exports = (sequelize) => {
  sequelize.define('UserOtpChallenge', {
    id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id:    { type: DataTypes.INTEGER, allowNull: false },
    purpose:    { type: DataTypes.ENUM('phone_change_old', 'phone_change_new', 'email_change'), allowNull: false },
    phone:      { type: DataTypes.STRING(20), allowNull: false },
    otp_hash:   { type: DataTypes.STRING(255), allowNull: false },
    attempts:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    used_at:    { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'user_otp_challenges', updatedAt: false });
};
