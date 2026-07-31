const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Asset = sequelize.define('Asset', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    category_id: { type: DataTypes.INTEGER, allowNull: true },
    name:        { type: DataTypes.STRING(200), allowNull: false },
    s3_key:      { type: DataTypes.STRING(500), allowNull: false },
    asset_type:  { type: DataTypes.ENUM('icon', 'emoji', 'shape', 'font', 'audio', 'video', 'animated', 'bg'), allowNull: false },
    is_premium:  { type: DataTypes.TINYINT, defaultValue: 0 },
    status:      { type: DataTypes.ENUM('active', 'inactive'), defaultValue: 'active' },
  }, { tableName: 'assets' });

  Asset.associate = (models) => {
    Asset.belongsTo(models.AssetCategory,    { foreignKey: 'category_id' });
    Asset.belongsToMany(models.Tag,          { through: models.AssetTag, foreignKey: 'asset_id' });
  };

  return Asset;
};
