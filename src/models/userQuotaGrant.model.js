const { DataTypes } = require('sequelize');

// One purchased (or admin-granted) block of quota. A user's top-up balance for a
// feature is the sum over their ACTIVE grants — this table is the balance, not a
// cache of it.
//
// `quantity` is snapshotted from the pack at purchase rather than read back
// through `quota_pack_id`: editing a pack must never retroactively change what
// somebody already paid for.
//
// `consumed` only moves for FLOW features (ai_credits and anything else whose
// reset_period is monthly). Their counter is zeroed every cycle, so purchased
// credits have to be debited here at the moment they are spent or the reset would
// hand them back every month forever. GAUGE features (storage) leave `consumed`
// at 0 — their counter tracks occupancy directly, and the grant just raises the
// ceiling, so freeing a file returns the purchased headroom on its own.
module.exports = (sequelize) => {
  const UserQuotaGrant = sequelize.define('UserQuotaGrant', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:         { type: DataTypes.INTEGER, allowNull: false },
    feature_type_id: { type: DataTypes.INTEGER, allowNull: false },
    quota_pack_id:   { type: DataTypes.INTEGER, allowNull: true },
    // Feature units (credits / MB), same convention as plan_features.value.
    quantity:        { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    consumed:        { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    source:          { type: DataTypes.ENUM('purchase', 'admin_grant'), allowNull: false, defaultValue: 'purchase' },
    payment_id:      { type: DataTypes.INTEGER, allowNull: true },
    // pending -> ordered, not yet confirmed. Contributes nothing to the balance.
    // active  -> spendable
    // revoked -> withdrawn by an admin. Kept as the audit record, never deleted;
    //            both its quantity and its consumed leave the balance together, so
    //            revoking a fully-spent grant is a no-op rather than a clawback.
    status:          { type: DataTypes.ENUM('pending', 'active', 'revoked'), allowNull: false, defaultValue: 'pending' },
    note:            { type: DataTypes.STRING(255), allowNull: true },
    granted_at:      { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'user_quota_grants' });

  UserQuotaGrant.associate = (models) => {
    UserQuotaGrant.belongsTo(models.User,        { foreignKey: 'user_id' });
    UserQuotaGrant.belongsTo(models.FeatureType, { foreignKey: 'feature_type_id' });
    UserQuotaGrant.belongsTo(models.QuotaPack,   { foreignKey: 'quota_pack_id' });
    UserQuotaGrant.belongsTo(models.Payment,     { foreignKey: 'payment_id' });
  };

  return UserQuotaGrant;
};
