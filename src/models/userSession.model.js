const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UserSession = sequelize.define('UserSession', {
    id:                 { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:                { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    actor_type:         { type: DataTypes.ENUM('user', 'admin'), allowNull: false },
    actor_id:           { type: DataTypes.INTEGER, allowNull: false },
    jti:                { type: DataTypes.UUID, allowNull: false, unique: true },
    refresh_token_hash: { type: DataTypes.STRING(255), allowNull: false },
    client_type:        { type: DataTypes.STRING(50), allowNull: true },
    ip_address:         { type: DataTypes.STRING(45), allowNull: true },
    device_info:        { type: DataTypes.TEXT, allowNull: true },
    expires_at:         { type: DataTypes.DATE, allowNull: false },
    is_revoked:         { type: DataTypes.TINYINT, defaultValue: 0 },
  }, { tableName: 'user_sessions', updatedAt: false });

  return UserSession;
};
