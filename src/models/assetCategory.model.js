const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const AssetCategory = sequelize.define('AssetCategory', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    parent_id:     { type: DataTypes.INTEGER, allowNull: true },
    name:          { type: DataTypes.STRING(100), allowNull: false },
    slug:          { type: DataTypes.STRING(120), allowNull: true, unique: true },
    display_order: { type: DataTypes.INTEGER, defaultValue: 0 },
    is_active:     { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'asset_categories' });

  AssetCategory.associate = (models) => {
    AssetCategory.belongsTo(AssetCategory,    { as: 'parent', foreignKey: 'parent_id' });
    AssetCategory.hasMany(AssetCategory,      { as: 'children', foreignKey: 'parent_id' });
    AssetCategory.hasMany(models.Asset,       { foreignKey: 'category_id' });
  };

  return AssetCategory;
};
