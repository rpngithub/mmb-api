const { DataTypes } = require('sequelize');

// SEO cross-links between industries. Directional: the row belongs to
// `category_id`'s landing page and points at `related_category_id`. The column
// names keep the business_category wording of the table they join; `industry`
// is the public/frontend name for the same entity, renamed at the API layer.
module.exports = (sequelize) => {
  sequelize.define('BusinessCategoryRelated', {
    id:                  { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    category_id:         { type: DataTypes.INTEGER, allowNull: false },
    related_category_id: { type: DataTypes.INTEGER, allowNull: false },
    display_order:       { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, { tableName: 'business_category_related', timestamps: false });
};
