const { DataTypes } = require('sequelize');

// One attempt at changing a user's login phone. See services/phoneChange.service.js
// for the two methods and the order their steps must happen in.
module.exports = (sequelize) => {
  sequelize.define('PhoneChangeRequest', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:         { type: DataTypes.INTEGER, allowNull: false },
    method:          { type: DataTypes.ENUM('old_phone', 'email_link'), allowNull: false },
    status:          { type: DataTypes.ENUM('open', 'completed', 'cancelled'), allowNull: false, defaultValue: 'open' },
    old_phone:       { type: DataTypes.STRING(20), allowNull: false },
    new_phone:       { type: DataTypes.STRING(20), allowNull: true },
    // old_phone method: when the OTP to the current number was confirmed.
    old_verified_at: { type: DataTypes.DATE, allowNull: true },
    // email_link method: sha256 of the token in the emailed link.
    link_token_hash: { type: DataTypes.CHAR(64), allowNull: true, unique: true },
    expires_at:      { type: DataTypes.DATE, allowNull: false },
    completed_at:    { type: DataTypes.DATE, allowNull: true },
    ip_address:      { type: DataTypes.STRING(45), allowNull: true },
  }, { tableName: 'phone_change_requests' });
};
