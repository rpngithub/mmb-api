const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ProductImage = sequelize.define('ProductImage', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    product_id:    { type: DataTypes.INTEGER, allowNull: false },
    s3_key:        { type: DataTypes.STRING(500), allowNull: false },
    display_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  }, { tableName: 'product_images', updatedAt: false });

  ProductImage.associate = (models) => {
    ProductImage.belongsTo(models.Product, { foreignKey: 'product_id' });
  };

  return ProductImage;
};
