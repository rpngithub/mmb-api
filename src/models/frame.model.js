const { DataTypes } = require('sequelize');

// An admin-authored frame: the branded border a user applies over their designs.
//
// Structurally a sibling of TemplateFamily — categorised, staged through
// draft/active/inactive — with its designs in `frame_versions`, one per language ×
// size, because a frame must match the poster it sits on (migration 058). It
// differs in how it is PAID for: a premium frame is bought outright for its own
// `price`, so there is no frames↔plans join the way variants have one. Ownership
// lives in `user_frames`, is per FRAME (every version comes with it) and outlives
// any subscription, because no subscription granted it.
module.exports = (sequelize) => {
  const Frame = sequelize.define('Frame', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    category_id:      { type: DataTypes.INTEGER, allowNull: true },
    name:             { type: DataTypes.STRING(200), allowNull: false },
    description:      { type: DataTypes.TEXT, allowNull: true },
    frame_type:       { type: DataTypes.ENUM('static', 'animated'), allowNull: false, defaultValue: 'static' },
    is_premium:       { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    price:            { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    // Display-only "was" price shown struck through beside `price`. NULL = no promotion.
    strike_price:     { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    display_order:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status:           { type: DataTypes.ENUM('draft', 'active', 'inactive'), allowNull: false, defaultValue: 'draft' },
    created_by:       { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'frames' });

  Frame.associate = (models) => {
    Frame.belongsTo(models.FrameCategory, { foreignKey: 'category_id' });
    Frame.belongsTo(models.AdminUser,     { foreignKey: 'created_by', as: 'creator' });
    Frame.hasMany(models.UserFrame,       { foreignKey: 'frame_id' });
    Frame.hasMany(models.FrameVersion,    { foreignKey: 'frame_id', as: 'versions' });
  };

  return Frame;
};
