const { DataTypes } = require('sequelize');
const { jsonColumn } = require('../utils/jsonColumn');

// One bulk template import. See migration 20260101000066 and
// src/services/templateImport.service.js.
module.exports = (sequelize) => {
  const TemplateImportBatch = sequelize.define('TemplateImportBatch', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    label:            { type: DataTypes.STRING(200), allowNull: true },
    created_by:       { type: DataTypes.INTEGER, allowNull: true },
    status:           { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'draft' },
    total_items:      { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    summary:          jsonColumn('summary', { allowNull: true }),
    last_activity_at: { type: DataTypes.DATE, allowNull: true },
    started_at:       { type: DataTypes.DATE, allowNull: true },
    finished_at:      { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'template_import_batches' });

  TemplateImportBatch.associate = (models) => {
    TemplateImportBatch.hasMany(models.TemplateImportItem, { foreignKey: 'batch_id', as: 'items' });
    TemplateImportBatch.belongsTo(models.AdminUser, { foreignKey: 'created_by', as: 'creator' });
  };

  return TemplateImportBatch;
};
