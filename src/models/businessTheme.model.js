const { DataTypes } = require('sequelize');

// Business-scoped theme adoption ("Add to your Business"). Access checks query
// this table directly (by business_id / theme_id), so no M2M convenience
// associations are defined. created_at is kept to order a business's collection.
module.exports = (sequelize) => {
  sequelize.define('BusinessTheme', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    business_id: { type: DataTypes.INTEGER, allowNull: false },
    theme_id:    { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'business_themes', updatedAt: false });
};
