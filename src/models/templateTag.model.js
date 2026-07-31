const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('TemplateTag', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    template_id: { type: DataTypes.INTEGER, allowNull: false },
    tag_id:      { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'template_tags', timestamps: false });
};
