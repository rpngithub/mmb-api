const { DataTypes } = require('sequelize');

// An admin-authored frame: the branded border a user applies over their designs.
//
// Structurally this is a sibling of Template — categorised, staged through
// draft/active/inactive, carrying a `content` design payload the editor fills
// from the owner's Brand Kit. It differs in how it is PAID for: a premium frame
// is bought outright for its own `price`, so there is no frames↔plans join the
// way variants have one. Ownership lives in `user_frames` and outlives any
// subscription, because no subscription granted it.
module.exports = (sequelize) => {
  const Frame = sequelize.define('Frame', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    category_id:      { type: DataTypes.INTEGER, allowNull: true },
    name:             { type: DataTypes.STRING(200), allowNull: false },
    description:      { type: DataTypes.TEXT, allowNull: true },
    thumbnail_s3_key: { type: DataTypes.STRING(500), allowNull: true },
    // Same contract as templates.content — the editor's design payload, with slots
    // it fills from the Brand Kit (logo, phone, email). Not a flat overlay image,
    // which is why there is no s3_key for the frame itself.
    content:          { type: DataTypes.TEXT('long'), allowNull: true },
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
  };

  return Frame;
};
