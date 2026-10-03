const { DataTypes } = require('sequelize');

// One VERSION of a design (TemplateFamily): a language × size with its own design
// JSON and thumbnail. Everything shared — category, industries, tags, access level,
// counters — is on the family. Unique per (family, language, size); see migration 045.
module.exports = (sequelize) => {
  const Template = sequelize.define('Template', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    family_id:        { type: DataTypes.INTEGER, allowNull: false },
    // The language the design's text is in. NULL = text-free (no text, or symbols
    // only) and shown to everyone regardless of their preferred languages. A family
    // is all text-free or all languages, never a mix.
    language_id:      { type: DataTypes.INTEGER, allowNull: true },
    // Exactly one size per version. NULL only while a draft is being set up.
    size_id:          { type: DataTypes.INTEGER, allowNull: true },
    // A label for admins; unique names live on the family.
    name:             { type: DataTypes.STRING(200), allowNull: false },
    thumbnail_s3_key: { type: DataTypes.STRING(500), allowNull: true },
    content:          { type: DataTypes.TEXT('long'), allowNull: true },
    status:           { type: DataTypes.ENUM('active', 'inactive', 'draft'), defaultValue: 'draft' },
    created_by:       { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'templates' });

  Template.associate = (models) => {
    Template.belongsTo(models.TemplateFamily, { foreignKey: 'family_id', as: 'family' });
    Template.belongsTo(models.Language,       { foreignKey: 'language_id' });
    Template.belongsTo(models.TemplateSize,   { foreignKey: 'size_id' });
    Template.belongsTo(models.AdminUser,      { foreignKey: 'created_by', as: 'creator' });
  };

  return Template;
};
