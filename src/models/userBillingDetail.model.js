const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UserBillingDetail = sequelize.define('UserBillingDetail', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id:         { type: DataTypes.INTEGER, allowNull: false, unique: true },
    billing_name:    { type: DataTypes.STRING(200), allowNull: false },
    gstin:           { type: DataTypes.STRING(15), allowNull: true },
    billing_address: { type: DataTypes.TEXT, allowNull: false },
    billing_state:   { type: DataTypes.STRING(100), allowNull: false },
    billing_pincode: { type: DataTypes.STRING(10), allowNull: false },
  }, { tableName: 'user_billing_details', createdAt: false });

  UserBillingDetail.associate = (models) => {
    UserBillingDetail.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return UserBillingDetail;
};
