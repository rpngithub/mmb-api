const { DataTypes } = require('sequelize');

// What a user OWNS from the frames store — "My Frames".
//
// One row per (user, frame), ever. Removing a frame from the shelf sets
// status='removed' rather than deleting, so re-adding a frame that was paid for
// never charges twice; the unique index makes "do they already own this?" a
// single lookup instead of a scan through payments.
//
// A purchase writes this row as 'pending' with the payment attached and flips it
// to 'active' when Razorpay confirms — the same pending-then-activate shape
// user_subscriptions uses, so the existing webhook remains the source of truth.
module.exports = (sequelize) => {
  const UserFrame = sequelize.define('UserFrame', {
    id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:      { type: DataTypes.INTEGER, allowNull: false },
    frame_id:     { type: DataTypes.INTEGER, allowNull: false },
    acquired_via: { type: DataTypes.ENUM('free', 'purchase'), allowNull: false, defaultValue: 'free' },
    payment_id:   { type: DataTypes.INTEGER, allowNull: true },
    status:       { type: DataTypes.ENUM('pending', 'active', 'removed'), allowNull: false, defaultValue: 'active' },
    acquired_at:  { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'user_frames' });

  UserFrame.associate = (models) => {
    UserFrame.belongsTo(models.User,    { foreignKey: 'user_id' });
    UserFrame.belongsTo(models.Frame,   { foreignKey: 'frame_id' });
    UserFrame.belongsTo(models.Payment, { foreignKey: 'payment_id' });
  };

  return UserFrame;
};
