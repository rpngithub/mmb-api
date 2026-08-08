const { DataTypes } = require('sequelize');

// A CONTENT language — which templates a user is shown, not the app's UI language.
// Admin-governed so a designer cannot invent one by typing a code.
module.exports = (sequelize) => {
  const Language = sequelize.define('Language', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    code:          { type: DataTypes.STRING(10), allowNull: false, unique: true },   // 'en', 'ta'
    name:          { type: DataTypes.STRING(50), allowNull: false, unique: true },   // 'Tamil'
    // What the picker renders — a Tamil speaker looks for "தமிழ்", not "Tamil".
    native_name:   { type: DataTypes.STRING(50), allowNull: false },
    display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    is_active:     { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
  }, { tableName: 'languages' });

  Language.associate = (models) => {
    Language.hasMany(models.Template,     { foreignKey: 'language_id' });
    Language.belongsToMany(models.User,   { through: models.UserLanguage, foreignKey: 'language_id' });
    Language.belongsToMany(models.Font,   { through: models.FontLanguage, foreignKey: 'language_id' });
  };

  return Language;
};
