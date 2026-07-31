const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ThemeGroup = sequelize.define('ThemeGroup', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:          { type: DataTypes.STRING(100), allowNull: false },
    slug:          { type: DataTypes.STRING(120), allowNull: true, unique: true },
    display_order: { type: DataTypes.INTEGER, defaultValue: 0 },
    is_active:     { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'theme_groups' });

  ThemeGroup.associate = (models) => {
    ThemeGroup.hasMany(models.Theme, { foreignKey: 'group_id' });
  };

  return ThemeGroup;
};
