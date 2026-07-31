const { DataTypes } = require('sequelize');

// A Brand Series ("Lemon Buzz", "Midnight Rebel") is a family of Variants sharing a
// look. The series carries the marketing copy and the descriptive taxonomies; the
// premium gating and the industry targeting live on its Variants, not here.
module.exports = (sequelize) => {
  const BrandSeries = sequelize.define('BrandSeries', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:          { type: DataTypes.STRING(100), allowNull: false },
    slug:          { type: DataTypes.STRING(120), allowNull: true, unique: true },
    icon_s3_key:   { type: DataTypes.STRING(500), allowNull: true },
    caption:       { type: DataTypes.STRING(255), allowNull: true },   // sub-title: "Bright ideas deserve bright branding"
    description:   { type: DataTypes.TEXT, allowNull: true },
    display_order: { type: DataTypes.INTEGER, defaultValue: 0 },
    is_active:     { type: DataTypes.TINYINT, defaultValue: 1 },
    // "Series" is already both singular and plural. Left to itself Sequelize strips the
    // trailing -ies and names the association `BrandSery`, which would surface verbatim
    // in API responses — so pin both forms.
  }, { tableName: 'brand_series', name: { singular: 'BrandSeries', plural: 'BrandSeries' } });

  BrandSeries.associate = (models) => {
    BrandSeries.hasMany(models.Variant, { foreignKey: 'series_id' });

    // Three descriptive collections, each a full-replace M2M from the admin API.
    // otherKey is explicit throughout: the column names are snake_case and Sequelize
    // would otherwise guess `StylePersonalityId` / `TagId` / `ColorId`.
    BrandSeries.belongsToMany(models.StylePersonality, { through: models.BrandSeriesStylePersonality, foreignKey: 'brand_series_id', otherKey: 'style_personality_id' });
    BrandSeries.belongsToMany(models.Tag,              { through: models.BrandSeriesTag,              foreignKey: 'brand_series_id', otherKey: 'tag_id' });
    BrandSeries.belongsToMany(models.Color,            { through: models.BrandSeriesColor,            foreignKey: 'brand_series_id', otherKey: 'color_id' });
  };

  return BrandSeries;
};
