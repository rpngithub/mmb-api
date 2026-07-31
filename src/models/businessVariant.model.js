const { DataTypes } = require('sequelize');

// Business-scoped variant adoption ("Use This Brand Series" — the button says series,
// the grant is per-variant). Access checks query this table directly (by business_id /
// variant_id), so no M2M convenience associations are defined. created_at is kept to
// order a business's collection.
module.exports = (sequelize) => {
  sequelize.define('BusinessVariant', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    business_id: { type: DataTypes.INTEGER, allowNull: false },
    variant_id:  { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'business_variants', updatedAt: false });
};
