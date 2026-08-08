const { DataTypes } = require('sequelize');

// The owner's "My Keywords" picks — the tags that describe their products &
// services. Same taxonomy as `business_category_tags` (which holds the SUGGESTED
// keywords per industry); this table holds what the owner actually chose.
// A keyword is never free text: every row points at an existing `tags` row.
module.exports = (sequelize) => {
  sequelize.define('BusinessTag', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    business_id: { type: DataTypes.INTEGER, allowNull: false },
    tag_id:      { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'business_tags', timestamps: false });
};
