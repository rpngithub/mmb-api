const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('OtpCode', {
    id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    phone:      { type: DataTypes.STRING(20), allowNull: false },
    otp_hash:   { type: DataTypes.STRING(255), allowNull: false },
    purpose:    { type: DataTypes.ENUM('login', 'signup', 'reset'), allowNull: false },
    attempts:   { type: DataTypes.INTEGER, defaultValue: 0 },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    is_used:    { type: DataTypes.TINYINT, defaultValue: 0 },
  }, { tableName: 'otp_codes', updatedAt: false });
};
