const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('VariantTemplate', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    variant_id:  { type: DataTypes.INTEGER, allowNull: false },
    template_id: { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'variant_templates', timestamps: false });
};
