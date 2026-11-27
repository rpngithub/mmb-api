const { DataTypes } = require('sequelize');

// A user's own edited copy of one frame VERSION. The original stays on
// frame_versions and is never written by users; GET /frames/:uid serves this copy
// in its place for the picked version. One per (user, version) — see migration 067.
module.exports = (sequelize) => {
  const UserFrameDesign = sequelize.define('UserFrameDesign', {
    id:                  { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:                 { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:             { type: DataTypes.INTEGER, allowNull: false },
    frame_version_id:    { type: DataTypes.INTEGER, allowNull: false },
    content:             { type: DataTypes.TEXT('long'), allowNull: false },
    thumbnail_s3_key:    { type: DataTypes.STRING(500), allowNull: true },
    // The version's updated_at when this copy was last saved; a newer one means the
    // admin changed the original since (`original_updated`).
    original_updated_at: { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'user_frame_designs' });

  UserFrameDesign.associate = (models) => {
    UserFrameDesign.belongsTo(models.User,         { foreignKey: 'user_id' });
    UserFrameDesign.belongsTo(models.FrameVersion, { foreignKey: 'frame_version_id' });
  };

  return UserFrameDesign;
};
