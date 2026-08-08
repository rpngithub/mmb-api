const { DataTypes } = require('sequelize');

// One row per CONFIRMED user upload, carrying the byte count that was charged to
// `user_quota_usage.storage_used_bytes`. Release reads `bytes` back rather than
// re-measuring the object, so the counter can never drift when S3 is unreachable.
module.exports = (sequelize) => {
  const UserUpload = sequelize.define('UserUpload', {
    id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:      { type: DataTypes.INTEGER, allowNull: false },
    s3_key:       { type: DataTypes.STRING(500), allowNull: false, unique: true },
    slot:         { type: DataTypes.STRING(30), allowNull: false },
    bytes:        { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    content_type: { type: DataTypes.STRING(100), allowNull: true },
    // Grid metadata, supplied by the client at confirm — the editor needs pixel
    // dimensions to place an image, and the stored key is a uuid so the user's
    // own filename would otherwise be lost. Nullable: the client may omit them,
    // and rows written before the media library existed have none.
    width:             { type: DataTypes.INTEGER, allowNull: true },
    height:            { type: DataTypes.INTEGER, allowNull: true },
    original_filename: { type: DataTypes.STRING(255), allowNull: true },
  }, { tableName: 'user_uploads', updatedAt: false });

  UserUpload.associate = (models) => {
    UserUpload.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return UserUpload;
};
