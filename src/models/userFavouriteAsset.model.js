const { DataTypes } = require('sequelize');

// An asset a user has hearted. One row per (user, asset). See migration 047.
module.exports = (sequelize) => {
  const UserFavouriteAsset = sequelize.define('UserFavouriteAsset', {
    id:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id:  { type: DataTypes.INTEGER, allowNull: false },
    asset_id: { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'user_favourite_assets', updatedAt: false });

  UserFavouriteAsset.associate = (models) => {
    UserFavouriteAsset.belongsTo(models.User,  { foreignKey: 'user_id' });
    UserFavouriteAsset.belongsTo(models.Asset, { foreignKey: 'asset_id' });
  };

  return UserFavouriteAsset;
};
