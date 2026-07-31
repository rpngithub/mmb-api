const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('AppSetting', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    key:         { type: DataTypes.STRING(100), allowNull: false, unique: true },
    value:       { type: DataTypes.TEXT, allowNull: true },
    type:        { type: DataTypes.ENUM('string', 'integer', 'boolean', 'json'), defaultValue: 'string' },
    description: { type: DataTypes.TEXT, allowNull: true },
    group:       { type: DataTypes.STRING(50), allowNull: true },
    is_public:   { type: DataTypes.TINYINT, defaultValue: 0 },
    updated_by:  { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'app_settings', createdAt: false });
};
