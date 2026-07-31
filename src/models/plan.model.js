const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Plan = sequelize.define('Plan', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:          { type: DataTypes.STRING(100), allowNull: false },
    description:   { type: DataTypes.TEXT, allowNull: true },
    plan_type:     { type: DataTypes.ENUM('subscription', 'access_pass'), allowNull: false, defaultValue: 'subscription' },
    trial_days:    { type: DataTypes.INTEGER, allowNull: true },   // free-trial length (subscription plans); null/0 = no trial
    pass_price:    { type: DataTypes.DECIMAL(10, 2), allowNull: true }, // ₹ fee (access_pass plans)
    pass_days:     { type: DataTypes.INTEGER, allowNull: true },   // access-pass duration
    is_popular:    { type: DataTypes.TINYINT, defaultValue: 0 },
    status:        { type: DataTypes.ENUM('active', 'inactive'), defaultValue: 'active' },
    display_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  }, { tableName: 'plans' });

  Plan.associate = (models) => {
    Plan.hasMany(models.PlanBillingOption, { foreignKey: 'plan_id' });
    Plan.hasMany(models.PlanFeature,       { foreignKey: 'plan_id' });
    Plan.hasMany(models.UserSubscription,  { foreignKey: 'plan_id' });
    Plan.belongsToMany(models.Coupon, {
      through: models.CouponPlanRestriction, foreignKey: 'plan_id', otherKey: 'coupon_id', as: 'coupons',
    });
  };

  return Plan;
};
