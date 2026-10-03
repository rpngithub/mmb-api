const { DataTypes } = require('sequelize');

// A design. Its versions (one per language × size) live in `templates`; everything
// they share lives here — taxonomy, access level, curation flags and the counters,
// so a popular design is not split across its languages. See migration 045.
module.exports = (sequelize) => {
  const TemplateFamily = sequelize.define('TemplateFamily', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:            { type: DataTypes.STRING(200), allowNull: false },
    category_id:     { type: DataTypes.INTEGER, allowNull: true },
    template_type:   { type: DataTypes.ENUM('image', 'video', 'animated'), defaultValue: 'image' },
    is_premium:      { type: DataTypes.TINYINT, defaultValue: 0 },
    // Curated "Popular" badge set by admins — independent of trending_score/counters.
    is_popular:      { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    trending_score:  { type: DataTypes.FLOAT, defaultValue: 0 },
    views_count:     { type: DataTypes.INTEGER, defaultValue: 0 },
    downloads_count: { type: DataTypes.INTEGER, defaultValue: 0 },
    likes_count:     { type: DataTypes.INTEGER, defaultValue: 0 },
    status:          { type: DataTypes.ENUM('active', 'inactive', 'draft'), defaultValue: 'draft' },
    created_by:      { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'template_families' });

  TemplateFamily.associate = (models) => {
    TemplateFamily.hasMany(models.Template,           { foreignKey: 'family_id', as: 'versions' });
    TemplateFamily.belongsTo(models.TemplateCategory, { foreignKey: 'category_id' });
    TemplateFamily.belongsTo(models.AdminUser,        { foreignKey: 'created_by', as: 'creator' });
    // otherKey is explicit on every M2M: the join columns are snake_case and several
    // targets have no reverse association to infer them from.
    TemplateFamily.belongsToMany(models.Tag,              { through: models.TemplateTag,              foreignKey: 'family_id', otherKey: 'tag_id' });
    TemplateFamily.belongsToMany(models.BusinessCategory, { through: models.TemplateBusinessCategory, foreignKey: 'family_id', otherKey: 'business_category_id' });
    TemplateFamily.belongsToMany(models.Variant,          { through: models.VariantTemplate,          foreignKey: 'family_id', otherKey: 'variant_id' });
    TemplateFamily.belongsToMany(models.SpecialEvent,     { through: models.SpecialEventTemplate,     foreignKey: 'family_id', otherKey: 'event_id' });
  };

  return TemplateFamily;
};
