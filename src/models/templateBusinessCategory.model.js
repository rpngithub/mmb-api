const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('TemplateBusinessCategory', {
    id:                   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    template_id:          { type: DataTypes.INTEGER, allowNull: false },
    business_category_id: { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'template_business_categories', timestamps: false });
};
