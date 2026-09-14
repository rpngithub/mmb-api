const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PageSection = sequelize.define('PageSection', {
    id:  { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    // Which website page the block belongs to; 'industry' is the only page wired
    // up today. See the migration (20260101000036) for why this is a string.
    page_key:    { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'industry' },
    // NULL = the default served to every industry; set = an override for that one.
    business_category_id: { type: DataTypes.INTEGER, allowNull: true },
    // The website's rendering key. Stable by contract — renaming a published one
    // blanks a live block.
    section_key: { type: DataTypes.STRING(50), allowNull: false },
    eyebrow:     { type: DataTypes.STRING(150), allowNull: true },
    heading:     { type: DataTypes.STRING(255), allowNull: true },
    subheading:  { type: DataTypes.TEXT, allowNull: true },
    image_s3_key: { type: DataTypes.STRING(500), allowNull: true },
    display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // On a DEFAULT row this is ordinary visibility. On an OVERRIDE row, 0 also
    // means "hide the inherited default for this industry" — the resolver reads
    // overrides regardless of this flag precisely so that can be expressed.
    is_active:     { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
  }, { tableName: 'page_sections' });

  PageSection.associate = (models) => {
    PageSection.belongsTo(models.BusinessCategory, { foreignKey: 'business_category_id' });
    PageSection.hasMany(models.PageSectionItem,    { as: 'items', foreignKey: 'section_id' });
  };

  return PageSection;
};
