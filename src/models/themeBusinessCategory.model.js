const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('ThemeBusinessCategory', {
    id:                   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    theme_id:             { type: DataTypes.INTEGER, allowNull: false },
    business_category_id: { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'theme_business_categories', timestamps: false });
};
