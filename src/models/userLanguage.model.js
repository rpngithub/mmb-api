const { DataTypes } = require('sequelize');

// The user's "Preferred Languages" picks. No rows = never chose, which the API
// treats as English — deliberately distinct from having chosen English only.
module.exports = (sequelize) => {
  sequelize.define('UserLanguage', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id:     { type: DataTypes.INTEGER, allowNull: false },
    language_id: { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'user_languages', timestamps: false });
};
