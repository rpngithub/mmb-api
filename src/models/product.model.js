const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Product = sequelize.define('Product', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    business_id: { type: DataTypes.INTEGER, allowNull: false },
    name:        { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    price:       { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    is_active:   { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'products' });

  Product.associate = (models) => {
    Product.belongsTo(models.Business,  { foreignKey: 'business_id' });
    Product.hasMany(models.ProductImage, { foreignKey: 'product_id' });
  };

  return Product;
};
