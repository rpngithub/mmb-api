const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Business = sequelize.define('Business', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:       { type: DataTypes.INTEGER, allowNull: false },
    category_id:   { type: DataTypes.INTEGER, allowNull: true },
    name:          { type: DataTypes.STRING(200), allowNull: false },
    description:   { type: DataTypes.TEXT, allowNull: true },
    logo_s3_key:   { type: DataTypes.STRING(500), allowNull: true },
    cover_s3_key:  { type: DataTypes.STRING(500), allowNull: true },
    latitude:      { type: DataTypes.DECIMAL(10, 8), allowNull: true },
    longitude:     { type: DataTypes.DECIMAL(11, 8), allowNull: true },
    geohash:       { type: DataTypes.STRING(12), allowNull: true },
    address:       { type: DataTypes.TEXT, allowNull: true },
    city:          { type: DataTypes.STRING(100), allowNull: true },
    state:         { type: DataTypes.STRING(100), allowNull: true },
    phone:           { type: DataTypes.STRING(20), allowNull: true },
    whatsapp:        { type: DataTypes.STRING(20), allowNull: true },
    email:           { type: DataTypes.STRING(150), allowNull: true },
    website:         { type: DataTypes.STRING(255), allowNull: true },
    social_links:    { type: DataTypes.JSON, allowNull: true },
    operating_hours: { type: DataTypes.JSON, allowNull: true },
    rating_avg:      { type: DataTypes.DECIMAL(2, 1), allowNull: false, defaultValue: 0 },
    rating_count:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    is_active:     { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'businesses' });

  Business.associate = (models) => {
    Business.belongsTo(models.User,             { foreignKey: 'user_id' });
    Business.belongsTo(models.BusinessCategory, { foreignKey: 'category_id' });
    Business.hasMany(models.Product,            { foreignKey: 'business_id' });
  };

  return Business;
};
