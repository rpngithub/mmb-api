const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Faq = sequelize.define('Faq', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    category_id:   { type: DataTypes.INTEGER, allowNull: true },
    question:      { type: DataTypes.TEXT, allowNull: false },
    answer:        { type: DataTypes.TEXT('long'), allowNull: false },
    display_order: { type: DataTypes.INTEGER, defaultValue: 0 },
    status:        { type: DataTypes.ENUM('active', 'inactive'), defaultValue: 'active' },
    created_by:    { type: DataTypes.INTEGER, allowNull: true },
    updated_by:    { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'faqs' });

  Faq.associate = (models) => {
    Faq.belongsTo(models.FaqCategory, { foreignKey: 'category_id' });
  };

  return Faq;
};
