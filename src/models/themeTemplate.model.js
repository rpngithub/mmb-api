const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('ThemeTemplate', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    theme_id:    { type: DataTypes.INTEGER, allowNull: false },
    template_id: { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'theme_templates', timestamps: false });
};
