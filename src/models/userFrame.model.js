const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UserFrame = sequelize.define('UserFrame', {
    id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:        { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:    { type: DataTypes.INTEGER, allowNull: false },
    name:       { type: DataTypes.STRING(200), allowNull: false },
    s3_key:     { type: DataTypes.STRING(500), allowNull: false },
    frame_type: { type: DataTypes.ENUM('image', 'animated'), defaultValue: 'image' },
    is_active:  { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'user_frames', updatedAt: false });

  UserFrame.associate = (models) => {
    UserFrame.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return UserFrame;
};
