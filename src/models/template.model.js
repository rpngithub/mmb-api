const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Template = sequelize.define('Template', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    category_id:      { type: DataTypes.INTEGER, allowNull: true },
    name:             { type: DataTypes.STRING(200), allowNull: false },
    thumbnail_s3_key: { type: DataTypes.STRING(500), allowNull: true },
    content:          { type: DataTypes.TEXT('long'), allowNull: true },
    template_type:    { type: DataTypes.ENUM('image', 'video', 'animated'), defaultValue: 'image' },
    is_premium:       { type: DataTypes.TINYINT, defaultValue: 0 },
    trending_score:   { type: DataTypes.FLOAT, defaultValue: 0 },
    views_count:      { type: DataTypes.INTEGER, defaultValue: 0 },
    downloads_count:  { type: DataTypes.INTEGER, defaultValue: 0 },
    likes_count:      { type: DataTypes.INTEGER, defaultValue: 0 },
    status:           { type: DataTypes.ENUM('active', 'inactive', 'draft'), defaultValue: 'draft' },
    created_by:       { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'templates' });

  Template.associate = (models) => {
    Template.belongsTo(models.TemplateCategory, { foreignKey: 'category_id' });
    Template.belongsTo(models.AdminUser,        { foreignKey: 'created_by', as: 'creator' });
    Template.belongsToMany(models.Tag,          { through: models.TemplateTag,              foreignKey: 'template_id' });
    Template.belongsToMany(models.TemplateSize, { through: models.TemplateSizeMap,          foreignKey: 'template_id' });
    Template.belongsToMany(models.Theme,        { through: models.ThemeTemplate,            foreignKey: 'template_id' });
    // otherKey must be explicit: BusinessCategory has no reverse belongsToMany(Template), so
    // Sequelize would otherwise default the join key to `BusinessCategoryId` (the actual column
    // is `business_category_id`) and break the join.
    Template.belongsToMany(models.BusinessCategory, { through: models.TemplateBusinessCategory, foreignKey: 'template_id', otherKey: 'business_category_id' });
    Template.belongsToMany(models.SpecialEvent, { through: models.SpecialEventTemplate,     foreignKey: 'template_id' });
  };

  return Template;
};
