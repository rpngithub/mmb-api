const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('SpecialEventTemplate', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    event_id:    { type: DataTypes.INTEGER, allowNull: false },
    template_id: { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'special_event_templates', timestamps: false });
};
