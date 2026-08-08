const { DataTypes } = require('sequelize');

// Which scripts a font can actually render. A Devanagari font cannot draw Tamil,
// so without this a user browsing Tamil templates could pick a brand font that
// renders every headline as boxes.
module.exports = (sequelize) => {
  sequelize.define('FontLanguage', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    font_id:     { type: DataTypes.INTEGER, allowNull: false },
    language_id: { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'font_languages', timestamps: false });
};
