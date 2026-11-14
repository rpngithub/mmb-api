const { DataTypes } = require('sequelize');

// What we actually paid a provider for its credits, from the card statement.
// Cost per provider unit is derived from these rows; see migration 20260101000059.
module.exports = (sequelize) => {
  const ProviderCreditPurchase = sequelize.define('ProviderCreditPurchase', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    provider_id:      { type: DataTypes.INTEGER, allowNull: false },
    purchased_at:     { type: DataTypes.DATE, allowNull: false },
    credits_received: { type: DataTypes.DECIMAL(16, 4), allowNull: false },
    amount_paid_inr:  { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    amount_foreign:   { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    currency:         { type: DataTypes.CHAR(3), allowNull: true },
    note:             { type: DataTypes.STRING(255), allowNull: true },
    created_by:       { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'provider_credit_purchases' });

  ProviderCreditPurchase.associate = (models) => {
    ProviderCreditPurchase.belongsTo(models.AiProvider, { foreignKey: 'provider_id', as: 'provider' });
  };

  return ProviderCreditPurchase;
};
