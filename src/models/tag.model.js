const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Tag = sequelize.define('Tag', {
    id:   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    slug: { type: DataTypes.STRING(120), allowNull: true, unique: true },
  }, { tableName: 'tags', updatedAt: false });

  Tag.associate = (models) => {
    Tag.belongsToMany(models.BusinessCategory, { through: models.BusinessCategoryTag, foreignKey: 'tag_id' });
    Tag.belongsToMany(models.Business,         { through: models.BusinessTag,         foreignKey: 'tag_id' });
    Tag.belongsToMany(models.Template,         { through: models.TemplateTag,         foreignKey: 'tag_id' });
    Tag.belongsToMany(models.Asset,            { through: models.AssetTag,            foreignKey: 'tag_id' });
    Tag.belongsToMany(models.BrandSeries,      { through: models.BrandSeriesTag,      foreignKey: 'tag_id', otherKey: 'brand_series_id' });
  };

  return Tag;
};
