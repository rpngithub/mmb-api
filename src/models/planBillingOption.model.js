const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PlanBillingOption = sequelize.define('PlanBillingOption', {
    id:                 { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    plan_id:            { type: DataTypes.INTEGER, allowNull: false },
    billing_cycle:      { type: DataTypes.ENUM('monthly', 'annual'), allowNull: false },
    price:              { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    discounted_price:   { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    discount_label:     { type: DataTypes.STRING(100), allowNull: true },
    currency:           { type: DataTypes.STRING(3), defaultValue: 'INR' },
    razorpay_plan_id:   { type: DataTypes.STRING(100), allowNull: true },
    is_active:          { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'plan_billing_options' });

  PlanBillingOption.associate = (models) => {
    PlanBillingOption.belongsTo(models.Plan, { foreignKey: 'plan_id' });
  };

  return PlanBillingOption;
};
