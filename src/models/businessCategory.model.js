const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const BusinessCategory = sequelize.define('BusinessCategory', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    parent_id:        { type: DataTypes.INTEGER, allowNull: true },
    name:             { type: DataTypes.STRING(100), allowNull: false },
    slug:             { type: DataTypes.STRING(120), allowNull: true, unique: true },
    icon_s3_key:      { type: DataTypes.STRING(500), allowNull: true },
    thumbnail_s3_key: { type: DataTypes.STRING(500), allowNull: true },
    display_order:    { type: DataTypes.INTEGER, defaultValue: 0 },
    // Moderation state, separate from the `is_active` visibility switch. A
    // user-suggested sub-industry ("Others" at signup) lands here as
    // status='pending' + is_active=0, so it stays out of every public catalogue
    // read until an admin approves it. Admin-created rows are 'approved'.
    status:               { type: DataTypes.ENUM('approved', 'pending', 'rejected'), allowNull: false, defaultValue: 'approved' },
    suggested_by_user_id: { type: DataTypes.INTEGER, allowNull: true },
    is_active:        { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'business_categories' });

  BusinessCategory.associate = (models) => {
    BusinessCategory.belongsTo(BusinessCategory,   { as: 'parent', foreignKey: 'parent_id' });
    BusinessCategory.hasMany(BusinessCategory,     { as: 'children', foreignKey: 'parent_id' });
    BusinessCategory.hasMany(models.Business,      { foreignKey: 'category_id' });
    // The owner who suggested this industry via "Others" (null for admin-created rows).
    BusinessCategory.belongsTo(models.User,        { as: 'suggestedBy', foreignKey: 'suggested_by_user_id' });
    BusinessCategory.belongsToMany(models.Tag,     { through: models.BusinessCategoryTag, foreignKey: 'category_id' });
    // SEO cross-links, curated per industry and ORDERED by the join row's
    // display_order. Directional: this is "industries THIS page links to", which
    // is not the same set as the industries that link back here.
    BusinessCategory.belongsToMany(BusinessCategory, {
      as: 'RelatedIndustries',
      through: models.BusinessCategoryRelated,
      foreignKey: 'category_id',
      otherKey: 'related_category_id',
    });
  };

  return BusinessCategory;
};
