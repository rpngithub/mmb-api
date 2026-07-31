const { DataTypes } = require('sequelize');

// Industries a variant suits ("Suitable For"). The column keeps its
// business_category_id name — `industry` is the public/frontend name for the same
// entity, renamed at the API layer only.
module.exports = (sequelize) => {
  sequelize.define('VariantIndustry', {
    id:                   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    variant_id:           { type: DataTypes.INTEGER, allowNull: false },
    business_category_id: { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'variant_industries', timestamps: false });
};
