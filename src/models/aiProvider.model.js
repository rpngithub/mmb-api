const { DataTypes } = require('sequelize');
const { jsonColumn } = require('../utils/jsonColumn');

// A provider we can send AI work to. `key` must name a code adapter in
// src/ai/providers. Settings only — the keys themselves live encrypted in
// ai_provider_credentials. See migration 20260101000059.
module.exports = (sequelize) => {
  const AiProvider = sequelize.define('AiProvider', {
    id:                { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:               { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    key:               { type: DataTypes.STRING(40), allowNull: false, unique: true },
    name:              { type: DataTypes.STRING(100), allowNull: false },
    status:            { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'disabled' },
    base_url:          { type: DataTypes.STRING(255), allowNull: true },
    credential_source: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'db' },
    rate_limit_rpm:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 45 },
    max_concurrency:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },
    timeout_ms:        { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30000 },
    cost_unit:         { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'credit' },
    cost_per_unit_inr: { type: DataTypes.DECIMAL(14, 6), allowNull: true },
    cost_updated_at:   { type: DataTypes.DATE, allowNull: true },
    settings:          jsonColumn('settings', { allowNull: true }),
    terms_url:         { type: DataTypes.STRING(500), allowNull: true },
    notes:             { type: DataTypes.TEXT, allowNull: true },
  }, { tableName: 'ai_providers' });

  AiProvider.associate = (models) => {
    AiProvider.hasMany(models.AiProviderCredential, { foreignKey: 'provider_id', as: 'credentials' });
    AiProvider.hasMany(models.AiOperationRoute,     { foreignKey: 'provider_id', as: 'routes' });
  };

  return AiProvider;
};
