const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ProjectExport = sequelize.define('ProjectExport', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    project_id:  { type: DataTypes.INTEGER, allowNull: false },
    user_id:     { type: DataTypes.INTEGER, allowNull: false },
    export_type: { type: DataTypes.ENUM('download', 'share'), allowNull: false },
    platform:    { type: DataTypes.ENUM('whatsapp', 'instagram', 'facebook', 'direct'), allowNull: true },
    s3_key:      { type: DataTypes.STRING(500), allowNull: true },
    file_size_bytes: { type: DataTypes.BIGINT, allowNull: true },
    status:      { type: DataTypes.ENUM('pending', 'success', 'failed'), defaultValue: 'pending' },
  }, { tableName: 'project_exports', updatedAt: false });

  ProjectExport.associate = (models) => {
    ProjectExport.belongsTo(models.Project, { foreignKey: 'project_id' });
    ProjectExport.belongsTo(models.User,    { foreignKey: 'user_id' });
  };

  return ProjectExport;
};
