const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const FaqCategory = sequelize.define('FaqCategory', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    name:          { type: DataTypes.STRING(100), allowNull: false },
    slug:          { type: DataTypes.STRING(120), allowNull: true, unique: true },
    display_order: { type: DataTypes.INTEGER, defaultValue: 0 },
    status:        { type: DataTypes.ENUM('active', 'inactive'), defaultValue: 'active' },
  }, { tableName: 'faq_categories' });

  FaqCategory.associate = (models) => {
    FaqCategory.hasMany(models.Faq, { foreignKey: 'category_id' });
  };

  return FaqCategory;
};
