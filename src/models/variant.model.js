const { DataTypes } = require('sequelize');

// A Variant ("Lemon Buzz-01") is one concrete look within a Brand Series, and the unit
// that premium access is granted on — both plan entitlement and business adoption
// attach here, not to the parent series.
module.exports = (sequelize) => {
  const Variant = sequelize.define('Variant', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    series_id:        { type: DataTypes.INTEGER, allowNull: false },
    badge_id:         { type: DataTypes.INTEGER, allowNull: true },   // the single "Popular" / "Fresh" chip
    name:             { type: DataTypes.STRING(100), allowNull: false },
    description:      { type: DataTypes.TEXT, allowNull: true },
    thumbnail_s3_key: { type: DataTypes.STRING(500), allowNull: true },
    likes_count:      { type: DataTypes.INTEGER, defaultValue: 0 },   // display-only figure on the variant card (no per-user like table yet)
    display_order:    { type: DataTypes.INTEGER, defaultValue: 0 },
    is_active:        { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'variants' });

  Variant.associate = (models) => {
    Variant.belongsTo(models.BrandSeries,  { foreignKey: 'series_id' });
    Variant.belongsTo(models.VariantBadge, { foreignKey: 'badge_id' });
    Variant.belongsToMany(models.Template, { through: models.VariantTemplate, foreignKey: 'variant_id' });
    // Plans entitled to this variant's templates. otherKey must be explicit: Plan has no
    // reverse belongsToMany(Variant), so Sequelize would default the join key to `PlanId`
    // (actual column is `plan_id`). Access = user's active plan_id ∈ this set.
    Variant.belongsToMany(models.Plan, { through: models.VariantPlanRestriction, foreignKey: 'variant_id', otherKey: 'plan_id' });
    // Industries this variant suits (display/filter). Same explicit-otherKey reason.
    Variant.belongsToMany(models.BusinessCategory, { through: models.VariantIndustry, foreignKey: 'variant_id', otherKey: 'business_category_id' });
  };

  return Variant;
};
