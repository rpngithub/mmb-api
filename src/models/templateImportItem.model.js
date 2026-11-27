const { DataTypes } = require('sequelize');
const { jsonColumn } = require('../utils/jsonColumn');

// One manifest row of a bulk template import = one template version.
module.exports = (sequelize) => {
  const TemplateImportItem = sequelize.define('TemplateImportItem', {
    id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    batch_id:        { type: DataTypes.INTEGER, allowNull: false },
    row_no:          { type: DataTypes.INTEGER, allowNull: false },
    line:            { type: DataTypes.INTEGER, allowNull: true },
    manifest:        jsonColumn('manifest', { allowNull: false }),
    family_name:     { type: DataTypes.STRING(200), allowNull: false },
    folder:          { type: DataTypes.STRING(500), allowNull: false },
    files:           jsonColumn('files', { allowNull: true }),
    content:         { type: DataTypes.TEXT('long'), allowNull: true },
    family_id:       { type: DataTypes.INTEGER, allowNull: true },
    template_id:     { type: DataTypes.INTEGER, allowNull: true },
    created_family:  { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    created_version: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    stage:           { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'awaiting_files' },
    result:          { type: DataTypes.STRING(12), allowNull: true },
    failed_stage:    { type: DataTypes.STRING(12), allowNull: true },
    errors:          jsonColumn('errors', { allowNull: true }),
    warnings:        jsonColumn('warnings', { allowNull: true }),
  }, { tableName: 'template_import_items' });

  TemplateImportItem.associate = (models) => {
    TemplateImportItem.belongsTo(models.TemplateImportBatch, { foreignKey: 'batch_id', as: 'batch' });
  };

  return TemplateImportItem;
};
