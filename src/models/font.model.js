const { DataTypes } = require('sequelize');

// A font family. One table for two sources, told apart by the owner:
//   user_id NULL -> curated library font, offered to everyone
//   user_id set  -> that user's own upload, private to them
// The brand kit therefore always points at `fonts`, and "may I use this?" is one
// question rather than an either/or across two tables.
module.exports = (sequelize) => {
  const Font = sequelize.define('Font', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:       { type: DataTypes.INTEGER, allowNull: true },
    family:        { type: DataTypes.STRING(100), allowNull: false },
    is_premium:    { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    is_active:     { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
  }, { tableName: 'fonts' });

  Font.associate = (models) => {
    Font.belongsTo(models.User,          { foreignKey: 'user_id' });
    Font.hasMany(models.FontFile,        { foreignKey: 'font_id' });
    // Script coverage. Empty = unspecified, treated as "usable anywhere" so a
    // font is never hidden just because nobody classified it.
    Font.belongsToMany(models.Language,  { through: models.FontLanguage, foreignKey: 'font_id' });
  };

  return Font;
};
