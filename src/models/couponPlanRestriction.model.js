const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('CouponPlanRestriction', {
    id:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    coupon_id: { type: DataTypes.INTEGER, allowNull: false },
    plan_id:   { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'coupon_plan_restrictions', timestamps: false });
};
