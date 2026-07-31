const { DataTypes } = require('sequelize');

// "Bold • Premium • Confident" — the strapline under a Brand Series name. Kept as its
// own taxonomy rather than folded into the shared `tags` pool, because a series carries
// both and they render differently (personality is the strapline, tags are the pills).
module.exports = (sequelize) => {
  const StylePersonality = sequelize.define('StylePersonality', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:          { type: DataTypes.STRING(100), allowNull: false },
    slug:          { type: DataTypes.STRING(120), allowNull: true, unique: true },
    display_order: { type: DataTypes.INTEGER, defaultValue: 0 },
    is_active:     { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'style_personalities' });

  StylePersonality.associate = (models) => {
    StylePersonality.belongsToMany(models.BrandSeries, { through: models.BrandSeriesStylePersonality, foreignKey: 'style_personality_id', otherKey: 'brand_series_id' });
  };

  return StylePersonality;
};
