const { DataTypes } = require('sequelize');
const { jsonColumn } = require('../utils/jsonColumn');

module.exports = (sequelize) => {
  const Role = sequelize.define('Role', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:        { type: DataTypes.STRING(100), allowNull: false, unique: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    // MUST be parsed, not a raw JSON string: authorizeAdmin does array membership
    // (`perms.includes('*')`) and on a string that degrades to a substring test.
    permissions: jsonColumn('permissions', { allowNull: false, defaultValue: [] }),
    is_system:   { type: DataTypes.TINYINT, defaultValue: 0 },
  }, { tableName: 'roles' });

  Role.associate = (models) => {
    Role.hasMany(models.AdminUser, { foreignKey: 'role_id' });
  };

  return Role;
};
