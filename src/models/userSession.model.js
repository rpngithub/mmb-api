const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UserSession = sequelize.define('UserSession', {
    id:                 { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:                { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    actor_type:         { type: DataTypes.ENUM('user', 'admin'), allowNull: false },
    actor_id:           { type: DataTypes.INTEGER, allowNull: false },
    // The REFRESH token's id. It rotates in place on every refresh, so `uid` —
    // not this — is what identifies the session for its whole life.
    jti:                { type: DataTypes.UUID, allowNull: false, unique: true },
    refresh_token_hash: { type: DataTypes.STRING(255), allowNull: false },
    // The refresh token this session just replaced, kept so a replay of it can be
    // recognised as reuse instead of silently failing. `rotated_at` dates the swap,
    // which is how an innocent retry is told apart from a stolen token. Null until
    // the session's first refresh.
    prev_jti:                { type: DataTypes.UUID, allowNull: true },
    prev_refresh_token_hash: { type: DataTypes.STRING(255), allowNull: true },
    rotated_at:              { type: DataTypes.DATE, allowNull: true },
    // The ACCESS token this session issued, so revoking the session can blacklist
    // it and take effect immediately instead of after its 15-minute life.
    access_jti:         { type: DataTypes.UUID, allowNull: true },
    access_expires_at:  { type: DataTypes.DATE, allowNull: true },
    // The access token from before the last rotation. The client is still holding it
    // for the rest of its 15 minutes, so a revoke has to blacklist this one too or
    // "sign out my other devices" does not actually sign them out.
    prev_access_jti:        { type: DataTypes.UUID, allowNull: true },
    prev_access_expires_at: { type: DataTypes.DATE, allowNull: true },
    client_type:        { type: DataTypes.STRING(50), allowNull: true },
    ip_address:         { type: DataTypes.STRING(45), allowNull: true },
    device_info:        { type: DataTypes.TEXT, allowNull: true },
    expires_at:         { type: DataTypes.DATE, allowNull: false },
    is_revoked:         { type: DataTypes.TINYINT, defaultValue: 0 },
  }, { tableName: 'user_sessions', updatedAt: false });

  return UserSession;
};
