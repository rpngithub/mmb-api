const { DataTypes } = require('sequelize');

// One VERSION of a frame: a language × size with its own design payload and
// thumbnail — the frames counterpart of Template (a version of a TemplateFamily).
// Everything shared, including what it costs and who owns it, is on the Frame.
// Unique per (frame, language, size); see migration 058.
module.exports = (sequelize) => {
  const FrameVersion = sequelize.define('FrameVersion', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    frame_id:         { type: DataTypes.INTEGER, allowNull: false },
    // NULL = text-free, shown to everyone whatever their preferred languages. A
    // frame is all text-free or all languages, never a mix.
    language_id:      { type: DataTypes.INTEGER, allowNull: true },
    // The poster size this frame fits (template_sizes). NULL only while a draft is set up.
    size_id:          { type: DataTypes.INTEGER, allowNull: true },
    thumbnail_s3_key: { type: DataTypes.STRING(500), allowNull: true },
    // Same contract as templates.content — the editor's design payload, with slots
    // it fills from the Brand Kit (logo, phone, email).
    content:          { type: DataTypes.TEXT('long'), allowNull: true },
    status:           { type: DataTypes.ENUM('draft', 'active', 'inactive'), allowNull: false, defaultValue: 'draft' },
    created_by:       { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'frame_versions' });

  FrameVersion.associate = (models) => {
    FrameVersion.belongsTo(models.Frame,        { foreignKey: 'frame_id' });
    FrameVersion.belongsTo(models.Language,     { foreignKey: 'language_id' });
    FrameVersion.belongsTo(models.TemplateSize, { foreignKey: 'size_id' });
    FrameVersion.belongsTo(models.AdminUser,    { foreignKey: 'created_by', as: 'creator' });
  };

  return FrameVersion;
};
