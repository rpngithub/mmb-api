const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UserSubscription = sequelize.define('UserSubscription', {
    id:                       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:                      { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:                  { type: DataTypes.INTEGER, allowNull: false },
    plan_id:                  { type: DataTypes.INTEGER, allowNull: false },
    plan_billing_option_id:   { type: DataTypes.INTEGER, allowNull: true },  // null for access-pass (no billing cycle)
    coupon_id:                { type: DataTypes.INTEGER, allowNull: true },
    sub_type:                 { type: DataTypes.ENUM('regular', 'trial', 'access_pass'), allowNull: false, defaultValue: 'regular' },
    status:                   { type: DataTypes.ENUM('pending', 'active', 'overridden', 'cancelled', 'expired'), defaultValue: 'active' },
    starts_at:                { type: DataTypes.DATE, allowNull: false },
    ends_at:                  { type: DataTypes.DATE, allowNull: false },
    cancelled_at:             { type: DataTypes.DATE, allowNull: true },
    auto_renew:               { type: DataTypes.TINYINT, defaultValue: 1 },
    amount_paid:              { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    razorpay_subscription_id: { type: DataTypes.STRING(100), allowNull: true },
  }, { tableName: 'user_subscriptions' });

  UserSubscription.associate = (models) => {
    UserSubscription.belongsTo(models.User,              { foreignKey: 'user_id' });
    UserSubscription.belongsTo(models.Plan,              { foreignKey: 'plan_id' });
    UserSubscription.belongsTo(models.PlanBillingOption, { foreignKey: 'plan_billing_option_id' });
    UserSubscription.belongsTo(models.Coupon,            { foreignKey: 'coupon_id' });
    UserSubscription.hasMany(models.Payment,             { foreignKey: 'subscription_id' });
  };

  return UserSubscription;
};
