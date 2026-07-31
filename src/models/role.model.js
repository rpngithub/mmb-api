const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Role = sequelize.define('Role', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:        { type: DataTypes.STRING(100), allowNull: false, unique: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    permissions: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    is_system:   { type: DataTypes.TINYINT, defaultValue: 0 },
  }, { tableName: 'roles' });

  Role.associate = (models) => {
    Role.hasMany(models.AdminUser, { foreignKey: 'role_id' });
  };

  return Role;
};
