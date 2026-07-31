const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const AdminUser = sequelize.define('AdminUser', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:          { type: DataTypes.STRING(100), allowNull: false },
    email:         { type: DataTypes.STRING(255), allowNull: false, unique: true },
    password_hash: { type: DataTypes.STRING(255), allowNull: false },
    role_id:       { type: DataTypes.INTEGER, allowNull: false },
    is_active:     { type: DataTypes.TINYINT, defaultValue: 1 },
    last_login_at: { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'admin_users' });

  AdminUser.associate = (models) => {
    AdminUser.belongsTo(models.Role, { foreignKey: 'role_id' });
    AdminUser.hasMany(models.UserSession,    { foreignKey: 'actor_id', scope: { actor_type: 'admin' }, constraints: false });
    AdminUser.hasMany(models.TokenBlacklist, { foreignKey: 'actor_id', scope: { actor_type: 'admin' }, constraints: false });
  };

  return AdminUser;
};
