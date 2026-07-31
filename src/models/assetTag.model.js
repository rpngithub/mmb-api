const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  sequelize.define('AssetTag', {
    id:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    asset_id: { type: DataTypes.INTEGER, allowNull: false },
    tag_id:   { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'asset_tags', timestamps: false });
};
