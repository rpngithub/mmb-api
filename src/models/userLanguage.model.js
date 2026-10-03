const { DataTypes } = require('sequelize');

// The user's "Preferred Languages" picks. No rows = never chose, which the API
// treats as English — deliberately distinct from having chosen English only.
module.exports = (sequelize) => {
  sequelize.define('UserLanguage', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id:     { type: DataTypes.INTEGER, allowNull: false },
    language_id: { type: DataTypes.INTEGER, allowNull: false },
    // The user's ranking: 0 = primary (the language a design's card is shown in), then fallbacks.
    position:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, { tableName: 'user_languages', timestamps: false });
};
