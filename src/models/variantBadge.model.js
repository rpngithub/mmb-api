const { DataTypes } = require('sequelize');

// The chip shown on a variant card — "Popular", "Fresh", "Dynamic" — each with its own
// icon. Admin-managed taxonomy: new badges are created, not hard-coded. A variant wears
// at most one, so this is a nullable FK on variants rather than a join table.
module.exports = (sequelize) => {
  const VariantBadge = sequelize.define('VariantBadge', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:          { type: DataTypes.STRING(100), allowNull: false },
    slug:          { type: DataTypes.STRING(120), allowNull: true, unique: true },
    icon_s3_key:   { type: DataTypes.STRING(500), allowNull: true },
    display_order: { type: DataTypes.INTEGER, defaultValue: 0 },
    is_active:     { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'variant_badges' });

  VariantBadge.associate = (models) => {
    VariantBadge.hasMany(models.Variant, { foreignKey: 'badge_id' });
  };

  return VariantBadge;
};
