const { DataTypes } = require('sequelize');

// The store's filter chips ("Branding Frames", "Promotional Frames"). Flat by
// design — template_categories nests because that catalogue is large enough to
// need drill-down; the frames store is one curated row of chips, ordered by
// display_order (adminCrud `reorderable`).
module.exports = (sequelize) => {
  const FrameCategory = sequelize.define('FrameCategory', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:          { type: DataTypes.STRING(100), allowNull: false },
    slug:          { type: DataTypes.STRING(120), allowNull: true, unique: true },
    display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    is_active:     { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
  }, { tableName: 'frame_categories' });

  FrameCategory.associate = (models) => {
    FrameCategory.hasMany(models.Frame, { foreignKey: 'category_id' });
  };

  return FrameCategory;
};
