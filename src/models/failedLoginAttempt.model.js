const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('FailedLoginAttempt', {
    id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    identifier:   { type: DataTypes.STRING(255), allowNull: false },
    ip_address:   { type: DataTypes.STRING(45), allowNull: true },
    attempt_type: { type: DataTypes.ENUM('password', 'otp'), allowNull: false },
  }, { tableName: 'failed_login_attempts', updatedAt: false });
};
