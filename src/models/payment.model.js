const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Payment = sequelize.define('Payment', {
    id:                    { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:                   { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:               { type: DataTypes.INTEGER, allowNull: false },
    subscription_id:       { type: DataTypes.INTEGER, allowNull: true },
    order_type:            { type: DataTypes.ENUM('subscription', 'one_time'), defaultValue: 'subscription' },
    // WHAT was bought. `order_type` only says how it was billed, and fulfilment
    // used to infer the purchasable from absence ("no subscription_id means a
    // frame") — an inference that stops being true the moment there is a third
    // kind. Nullable because rows predating the discriminator still exist; the
    // router treats NULL as 'frame', which is what they all were.
    purchase_type:         { type: DataTypes.ENUM('subscription', 'frame', 'quota_pack'), allowNull: true },
    amount:                { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    amount_before_tax:     { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    gst_rate:              { type: DataTypes.DECIMAL(5, 2), defaultValue: 18 },
    gst_amount:            { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    currency:              { type: DataTypes.STRING(3), defaultValue: 'INR' },
    status:                { type: DataTypes.ENUM('pending', 'success', 'failed', 'refunded'), defaultValue: 'pending' },
    razorpay_order_id:     { type: DataTypes.STRING(100), allowNull: true },
    razorpay_payment_id:   { type: DataTypes.STRING(100), allowNull: true },
    razorpay_signature:    { type: DataTypes.STRING(500), allowNull: true },
    failure_reason:        { type: DataTypes.TEXT, allowNull: true },
    paid_at:               { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'payments' });

  Payment.associate = (models) => {
    Payment.belongsTo(models.User,             { foreignKey: 'user_id' });
    Payment.belongsTo(models.UserSubscription, { foreignKey: 'subscription_id' });
  };

  return Payment;
};
