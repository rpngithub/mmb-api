const { DataTypes } = require('sequelize');

// One row per spend or refund of a metered feature.
//
// The Usage screen breaks AI credits down by tool ("Image Generation 120,
// Background Removal 40"), which a column per tool cannot support — every new AI
// feature would need a migration. Deriving it from an event stream instead means
// a new tool is a new string. It also gives support an actual answer to "you
// charged me and I got nothing", which flat counters never could.
//
// `amount` is in COUNTER units (bytes for storage, 1 per action elsewhere) and is
// negative for a release, so summing the stream reconciles against the counter the
// same way SUM(user_uploads.bytes) reconciles storage_used_bytes.
module.exports = (sequelize) => {
  const QuotaUsageEvent = sequelize.define('QuotaUsageEvent', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:         { type: DataTypes.INTEGER, allowNull: false },
    feature_type_id: { type: DataTypes.INTEGER, allowNull: false },
    // Free text against src/constants/quotaSources.js, not an enum — see above.
    source:          { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'other' },
    amount:          { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    // How the spend was funded. Recorded at spend time so the answer survives a
    // later plan change that would make it un-derivable.
    from_plan:       { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    from_topup:      { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    // Loose pointer at whatever caused it, e.g. ('project_export', 812).
    // Deliberately not an FK: the referenced row may be deleted and the usage
    // record has to outlive it.
    ref_type:        { type: DataTypes.STRING(40), allowNull: true },
    ref_id:          { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'quota_usage_events', updatedAt: false });

  QuotaUsageEvent.associate = (models) => {
    QuotaUsageEvent.belongsTo(models.User,        { foreignKey: 'user_id' });
    QuotaUsageEvent.belongsTo(models.FeatureType, { foreignKey: 'feature_type_id' });
  };

  return QuotaUsageEvent;
};
