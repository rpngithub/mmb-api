const { DataTypes } = require('sequelize');

// display_order carries the palette order shown on the series card (Black, Charcoal, Gold).
module.exports = (sequelize) => {
  sequelize.define('BrandSeriesColor', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    brand_series_id: { type: DataTypes.INTEGER, allowNull: false },
    color_id:        { type: DataTypes.INTEGER, allowNull: false },
    display_order:   { type: DataTypes.INTEGER, defaultValue: 0 },
  }, { tableName: 'brand_series_colors', timestamps: false });
};
