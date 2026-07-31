const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const SpecialEvent = sequelize.define('SpecialEvent', {
    id:               { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:             { type: DataTypes.STRING(200), allowNull: false },
    description:      { type: DataTypes.TEXT, allowNull: true },
    thumbnail_s3_key: { type: DataTypes.STRING(500), allowNull: true },   // card cover image
    banner_s3_key:    { type: DataTypes.STRING(500), allowNull: true },   // wide hero image
    type:             { type: DataTypes.ENUM('holiday', 'observance', 'awareness', 'custom'), allowNull: false },
    event_date:       { type: DataTypes.STRING(5), allowNull: true },
    full_date:        { type: DataTypes.DATEONLY, allowNull: true },
    is_recurring:     { type: DataTypes.TINYINT, defaultValue: 1 },
    is_active:        { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'special_events' });

  SpecialEvent.associate = (models) => {
    SpecialEvent.belongsToMany(models.Template, { through: models.SpecialEventTemplate, foreignKey: 'event_id' });
  };

  return SpecialEvent;
};
