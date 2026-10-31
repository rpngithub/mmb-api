const { DataTypes } = require('sequelize');

// One "verify your email" link. `email` is the address it was sent to: if the user
// changes their email before clicking, the old link no longer matches and is refused.
module.exports = (sequelize) => {
  sequelize.define('EmailVerificationToken', {
    id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id:    { type: DataTypes.INTEGER, allowNull: false },
    email:      { type: DataTypes.STRING(255), allowNull: false },
    // sha256 of the token in the link (utils/tokenHash). The token itself is never stored.
    token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    used_at:    { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'email_verification_tokens', updatedAt: false });
};
