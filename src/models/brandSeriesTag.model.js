const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('BrandSeriesTag', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    brand_series_id: { type: DataTypes.INTEGER, allowNull: false },
    tag_id:          { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'brand_series_tags', timestamps: false });
};
