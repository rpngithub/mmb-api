const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const TemplateCategory = sequelize.define('TemplateCategory', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    parent_id:        { type: DataTypes.INTEGER, allowNull: true },
    name:             { type: DataTypes.STRING(100), allowNull: false },
    slug:             { type: DataTypes.STRING(120), allowNull: true, unique: true },
    icon_s3_key:      { type: DataTypes.STRING(500), allowNull: true },
    thumbnail_s3_key: { type: DataTypes.STRING(500), allowNull: true },
    show_in_homepage: { type: DataTypes.TINYINT, defaultValue: 0 },
    display_order:    { type: DataTypes.INTEGER, defaultValue: 0 },
    is_active:        { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'template_categories' });

  TemplateCategory.associate = (models) => {
    TemplateCategory.belongsTo(TemplateCategory, { as: 'parent', foreignKey: 'parent_id' });
    TemplateCategory.hasMany(TemplateCategory,   { as: 'children', foreignKey: 'parent_id' });
    TemplateCategory.hasMany(models.Template,    { foreignKey: 'category_id' });
  };

  return TemplateCategory;
};
