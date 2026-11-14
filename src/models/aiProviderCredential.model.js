const { DataTypes } = require('sequelize');

// An encrypted provider secret (API key or webhook secret). The default scope
// leaves the ciphertext, IV and tag out of every query, so a careless include or
// an admin list can never serialise them; only src/ai/credentialStore.js reads
// them, via `.unscoped()`. See migration 20260101000059.
module.exports = (sequelize) => {
  const AiProviderCredential = sequelize.define('AiProviderCredential', {
    id:                 { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:                { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    provider_id:        { type: DataTypes.INTEGER, allowNull: false },
    kind:               { type: DataTypes.STRING(20), allowNull: false },
    ciphertext:         { type: DataTypes.BLOB, allowNull: false },
    iv:                 { type: DataTypes.BLOB, allowNull: false },
    auth_tag:           { type: DataTypes.BLOB, allowNull: false },
    master_key_version: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
    last4:              { type: DataTypes.STRING(8), allowNull: true },
    status:             { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
    created_by:         { type: DataTypes.INTEGER, allowNull: true },
    activated_at:       { type: DataTypes.DATE, allowNull: true },
    retired_at:         { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'ai_provider_credentials',
    defaultScope: { attributes: { exclude: ['ciphertext', 'iv', 'auth_tag'] } },
  });

  AiProviderCredential.associate = (models) => {
    AiProviderCredential.belongsTo(models.AiProvider, { foreignKey: 'provider_id', as: 'provider' });
  };

  return AiProviderCredential;
};
