const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('BrandSeriesStylePersonality', {
    id:                   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    brand_series_id:      { type: DataTypes.INTEGER, allowNull: false },
    style_personality_id: { type: DataTypes.INTEGER, allowNull: false },
    display_order:        { type: DataTypes.INTEGER, defaultValue: 0 },
  }, { tableName: 'brand_series_style_personalities', timestamps: false });
};
