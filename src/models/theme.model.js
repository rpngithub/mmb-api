const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Theme = sequelize.define('Theme', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    group_id:         { type: DataTypes.INTEGER, allowNull: false },
    name:             { type: DataTypes.STRING(100), allowNull: false },
    description:      { type: DataTypes.TEXT, allowNull: true },
    thumbnail_s3_key: { type: DataTypes.STRING(500), allowNull: true },
    likes_count:      { type: DataTypes.INTEGER, defaultValue: 0 },   // display-only figure on the theme card (no per-user like table yet)
    display_order:    { type: DataTypes.INTEGER, defaultValue: 0 },
    is_active:        { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'themes' });

  Theme.associate = (models) => {
    Theme.belongsTo(models.ThemeGroup,        { foreignKey: 'group_id' });
    Theme.belongsToMany(models.Template,      { through: models.ThemeTemplate, foreignKey: 'theme_id' });
    // Plans entitled to this theme's templates. otherKey must be explicit: Plan has no
    // reverse belongsToMany(Theme), so Sequelize would default the join key to `PlanId`
    // (actual column is `plan_id`). Access = user's active plan_id ∈ this set.
    Theme.belongsToMany(models.Plan, { through: models.ThemePlanRestriction, foreignKey: 'theme_id', otherKey: 'plan_id' });
    // Businesses this theme suits (display/filter). Same explicit-otherKey reason.
    Theme.belongsToMany(models.BusinessCategory, { through: models.ThemeBusinessCategory, foreignKey: 'theme_id', otherKey: 'business_category_id' });
  };

  return Theme;
};
