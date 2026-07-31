const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Testimonial = sequelize.define('Testimonial', {
    id:                   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:                  { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:                 { type: DataTypes.STRING(100), allowNull: false },
    designation:          { type: DataTypes.STRING(200), allowNull: true },
    business_category_id: { type: DataTypes.INTEGER, allowNull: true },
    content:              { type: DataTypes.TEXT, allowNull: false },
    rating:               { type: DataTypes.TINYINT, allowNull: true },
    photo_s3_key:         { type: DataTypes.STRING(500), allowNull: true },
    display_order:        { type: DataTypes.INTEGER, defaultValue: 0 },
    status:               { type: DataTypes.ENUM('active', 'inactive'), defaultValue: 'active' },
  }, { tableName: 'testimonials' });

  Testimonial.associate = (models) => {
    Testimonial.belongsTo(models.BusinessCategory, { foreignKey: 'business_category_id' });
  };

  return Testimonial;
};
