const { DataTypes } = require('sequelize');

// A submission from the Feedback screen: one of five faces, plus an optional note.
// Registered users only — `user_id` is required, so every entry is attributable
// and support has someone to reply to.
module.exports = (sequelize) => {
  const Feedback = sequelize.define('Feedback', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:     { type: DataTypes.INTEGER, allowNull: false },
    rating:      { type: DataTypes.TINYINT, allowNull: false },   // 1 (worst) - 5 (best)
    message:     { type: DataTypes.TEXT, allowNull: true },
    app_version: { type: DataTypes.STRING(30), allowNull: true },
    platform:    { type: DataTypes.STRING(30), allowNull: true },
  }, { tableName: 'feedbacks', updatedAt: false });

  Feedback.associate = (models) => {
    Feedback.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return Feedback;
};
