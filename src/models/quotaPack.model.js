const { DataTypes } = require('sequelize');

// A purchasable bundle of quota — "500 AI Credits, ₹99".
//
// Structurally a sibling of Frame: an admin-authored catalogue row, staged through
// draft/active/inactive, ordered by hand, priced pre-tax. It differs in what the
// purchase produces. Buying a frame creates an OWNERSHIP row (you have it or you
// do not); buying a pack creates a BALANCE row in user_quota_grants, so the same
// pack can be bought over and over.
//
// A pack is not tied to a plan. A top-up is extra headroom for the plan you
// already have, which is also why quotaPack.service refuses the sale when the
// buyer's plan makes the feature unlimited or does not enforce it at all — there
// would be nothing for the headroom to sit on top of.
module.exports = (sequelize) => {
  const QuotaPack = sequelize.define('QuotaPack', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    feature_type_id: { type: DataTypes.INTEGER, allowNull: false },
    name:            { type: DataTypes.STRING(150), allowNull: false },
    description:     { type: DataTypes.TEXT, allowNull: true },
    // In the FEATURE's own unit — credits, or MEGABYTES for storage — matching
    // plan_features.value. quota.service.LIMIT_SCALE is the single place that
    // converts either of them into counter units.
    quantity:        { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Pre-tax; GST is added at checkout by withGst(), as with plans and frames.
    price:           { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    // Display-only "was" price shown struck through beside `price`. NULL = no promotion.
    strike_price:    { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    badge:           { type: DataTypes.STRING(40), allowNull: true },
    display_order:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status:          { type: DataTypes.ENUM('draft', 'active', 'inactive'), allowNull: false, defaultValue: 'draft' },
    created_by:      { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'quota_packs' });

  QuotaPack.associate = (models) => {
    QuotaPack.belongsTo(models.FeatureType,     { foreignKey: 'feature_type_id' });
    QuotaPack.belongsTo(models.AdminUser,       { foreignKey: 'created_by', as: 'creator' });
    QuotaPack.hasMany(models.UserQuotaGrant,    { foreignKey: 'quota_pack_id' });
  };

  return QuotaPack;
};
