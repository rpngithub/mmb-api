const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('BusinessCategoryTag', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    category_id: { type: DataTypes.INTEGER, allowNull: false },
    tag_id:      { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'business_category_tags', timestamps: false });
};
