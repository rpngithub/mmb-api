const { DataTypes } = require('sequelize');

// Shared colour taxonomy so "Gold" resolves to one hex everywhere. Both the name and
// the code are exposed, letting the frontend render a swatch, a label, or both.
module.exports = (sequelize) => {
  const Color = sequelize.define('Color', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:          { type: DataTypes.STRING(100), allowNull: false },
    slug:          { type: DataTypes.STRING(120), allowNull: true, unique: true },
    hex_code:      { type: DataTypes.STRING(7), allowNull: false },   // #RRGGBB
    display_order: { type: DataTypes.INTEGER, defaultValue: 0 },
    is_active:     { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'colors' });

  Color.associate = (models) => {
    Color.belongsToMany(models.BrandSeries, { through: models.BrandSeriesColor, foreignKey: 'color_id', otherKey: 'brand_series_id' });
  };

  return Color;
};
