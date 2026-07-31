const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('TemplateSizeMap', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    template_id: { type: DataTypes.INTEGER, allowNull: false },
    size_id:     { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'template_size_map', timestamps: false });
};
