const { DataTypes } = require('sequelize');

// A design (template family) a user has hearted. One row per (user, design); the
// count of rows is mirrored into template_families.likes_count. See migration 047.
module.exports = (sequelize) => {
  const UserFavouriteTemplate = sequelize.define('UserFavouriteTemplate', {
    id:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id:   { type: DataTypes.INTEGER, allowNull: false },
    family_id: { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: 'user_favourite_templates', updatedAt: false });

  UserFavouriteTemplate.associate = (models) => {
    UserFavouriteTemplate.belongsTo(models.User,           { foreignKey: 'user_id' });
    UserFavouriteTemplate.belongsTo(models.TemplateFamily, { foreignKey: 'family_id' });
  };

  return UserFavouriteTemplate;
};
