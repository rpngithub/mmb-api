const { DataTypes } = require('sequelize');

// A variant the user BOUGHT outright — the third way into a variant, beside plan
// entitlement and business adoption (see variantAccess.service).
//
// One row per (user, variant), ever. Written as 'pending' with the payment
// attached and flipped to 'active' when Razorpay confirms — the same shape a
// frame purchase uses, so the existing webhook fulfils it. Never removed: an
// active row is permanent access and the proof they paid.
//
// Separate from business_variants on purpose: the `brand_series` quota meter
// counts that table, and a purchase must never count against the plan.
module.exports = (sequelize) => {
  const UserVariant = sequelize.define('UserVariant', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:     { type: DataTypes.INTEGER, allowNull: false },
    variant_id:  { type: DataTypes.INTEGER, allowNull: false },
    payment_id:  { type: DataTypes.INTEGER, allowNull: true },
    status:      { type: DataTypes.ENUM('pending', 'active'), allowNull: false, defaultValue: 'pending' },
    acquired_at: { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'user_variants' });

  UserVariant.associate = (models) => {
    UserVariant.belongsTo(models.User,    { foreignKey: 'user_id' });
    UserVariant.belongsTo(models.Variant, { foreignKey: 'variant_id' });
    UserVariant.belongsTo(models.Payment, { foreignKey: 'payment_id' });
  };

  return UserVariant;
};
