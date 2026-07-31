const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const TemplateSize = sequelize.define('TemplateSize', {
    id:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:      { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:     { type: DataTypes.STRING(100), allowNull: false },
    slug:     { type: DataTypes.STRING(120), allowNull: true, unique: true },
    width:    { type: DataTypes.INTEGER, allowNull: false },
    height:   { type: DataTypes.INTEGER, allowNull: false },
    unit:     { type: DataTypes.STRING(10), defaultValue: 'px' },
    platform: { type: DataTypes.ENUM('instagram', 'facebook', 'youtube', 'whatsapp', 'custom'), defaultValue: 'custom' },
    is_active: { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'template_sizes', updatedAt: false });

  TemplateSize.associate = (models) => {
    TemplateSize.belongsToMany(models.Template, { through: models.TemplateSizeMap, foreignKey: 'size_id' });
  };

  return TemplateSize;
};
