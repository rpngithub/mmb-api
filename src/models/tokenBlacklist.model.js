const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('TokenBlacklist', {
    id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    jti:        { type: DataTypes.UUID, allowNull: false, unique: true },
    actor_type: { type: DataTypes.ENUM('user', 'admin'), allowNull: false },
    actor_id:   { type: DataTypes.INTEGER, allowNull: false },
    reason:     { type: DataTypes.ENUM('logout', 'revoked', 'pwd_change'), allowNull: false },
    expires_at: { type: DataTypes.DATE, allowNull: false },
  }, { tableName: 'token_blacklist', updatedAt: false });
};
