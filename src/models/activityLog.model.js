const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('ActivityLog', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    actor_type:  { type: DataTypes.ENUM('user', 'admin'), allowNull: true },
    actor_id:    { type: DataTypes.INTEGER, allowNull: true },
    entity_type: { type: DataTypes.STRING(100), allowNull: true },
    entity_id:   { type: DataTypes.INTEGER, allowNull: true },
    action:      { type: DataTypes.STRING(100), allowNull: false },
    metadata:    { type: DataTypes.JSON, allowNull: true },
    ip_address:  { type: DataTypes.STRING(45), allowNull: true },
  }, { tableName: 'activity_logs', updatedAt: false });
};
