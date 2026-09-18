const { DataTypes } = require('sequelize');

const PRODUCT_TYPES = ['product', 'service'];

// One table for both products and services: they are listed together and differ
// only in which optional detail they carry (`unit` vs `service_area`).
module.exports = (sequelize) => {
  const Product = sequelize.define('Product', {
    id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    business_id:  { type: DataTypes.INTEGER, allowNull: false },
    type:         { type: DataTypes.ENUM(...PRODUCT_TYPES), allowNull: false, defaultValue: 'product' },
    name:         { type: DataTypes.STRING(200), allowNull: false },
    unit:         { type: DataTypes.STRING(50), allowNull: true },
    service_area: { type: DataTypes.STRING(200), allowNull: true },
    description:  { type: DataTypes.TEXT, allowNull: true },
    price:        { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    offer_price:  { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    is_active:    { type: DataTypes.TINYINT, defaultValue: 1 },
    // is_active is the owner's show/hide toggle; a delete is a delete. Paranoid
    // keeps deleted rows out of every read without each query having to say so.
    deleted_at:   { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'products', paranoid: true, deletedAt: 'deleted_at' });

  Product.associate = (models) => {
    Product.belongsTo(models.Business,  { foreignKey: 'business_id' });
    Product.hasMany(models.ProductImage, { foreignKey: 'product_id' });
  };

  Product.TYPES = PRODUCT_TYPES;
  return Product;
};
