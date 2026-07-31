const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Project = sequelize.define('Project', {
    id:                { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:               { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:           { type: DataTypes.INTEGER, allowNull: false },
    business_id:       { type: DataTypes.INTEGER, allowNull: true },
    template_id:       { type: DataTypes.INTEGER, allowNull: true },
    parent_project_id: { type: DataTypes.INTEGER, allowNull: true },
    size_id:           { type: DataTypes.INTEGER, allowNull: true },
    name:              { type: DataTypes.STRING(200), allowNull: false },
    content:           { type: DataTypes.TEXT('long'), allowNull: true },
    thumbnail_s3_key:  { type: DataTypes.STRING(500), allowNull: true },
    status:            { type: DataTypes.ENUM('draft', 'published', 'archived'), defaultValue: 'draft' },
  }, { tableName: 'projects' });

  Project.associate = (models) => {
    Project.belongsTo(models.User,         { foreignKey: 'user_id' });
    Project.belongsTo(models.Business,     { foreignKey: 'business_id' });
    Project.belongsTo(models.Template,     { foreignKey: 'template_id' });
    Project.belongsTo(Project,             { as: 'parent', foreignKey: 'parent_project_id' });
    Project.hasMany(Project,               { as: 'resized', foreignKey: 'parent_project_id' });
    Project.belongsTo(models.TemplateSize, { foreignKey: 'size_id' });
    Project.hasMany(models.ProjectExport,  { foreignKey: 'project_id' });
  };

  return Project;
};
