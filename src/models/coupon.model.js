const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Coupon = sequelize.define('Coupon', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    code:            { type: DataTypes.STRING(50), allowNull: false, unique: true },
    title:           { type: DataTypes.STRING(200), allowNull: false },
    discount_type:   { type: DataTypes.ENUM('percentage', 'fixed'), allowNull: false },
    discount_value:  { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    applicable_to:   { type: DataTypes.ENUM('all_plans', 'specific_plans'), defaultValue: 'all_plans' },
    target_audience: { type: DataTypes.ENUM('all', 'new_users', 'existing_users'), defaultValue: 'all' },
    max_uses:        { type: DataTypes.INTEGER, allowNull: true },
    used_count:      { type: DataTypes.INTEGER, defaultValue: 0 },
    valid_from:      { type: DataTypes.DATE, allowNull: false },
    valid_to:        { type: DataTypes.DATE, allowNull: true },
    status:          { type: DataTypes.ENUM('active', 'inactive', 'expired'), defaultValue: 'active' },
  }, { tableName: 'coupons' });

  Coupon.associate = (models) => {
    Coupon.hasMany(models.CouponPlanRestriction, { foreignKey: 'coupon_id' });
    Coupon.hasMany(models.UserSubscription,      { foreignKey: 'coupon_id' });
    Coupon.belongsToMany(models.Plan, {
      through: models.CouponPlanRestriction, foreignKey: 'coupon_id', otherKey: 'plan_id', as: 'plans',
    });
  };

  return Coupon;
};
