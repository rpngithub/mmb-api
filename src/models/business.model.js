const { DataTypes } = require('sequelize');
const { jsonColumn } = require('../utils/jsonColumn');

module.exports = (sequelize) => {
  const Business = sequelize.define('Business', {
    id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:       { type: DataTypes.INTEGER, allowNull: false },
    category_id:   { type: DataTypes.INTEGER, allowNull: true },
    name:          { type: DataTypes.STRING(200), allowNull: false },
    description:   { type: DataTypes.TEXT, allowNull: true },
    logo_s3_key:   { type: DataTypes.STRING(500), allowNull: true },
    cover_s3_key:  { type: DataTypes.STRING(500), allowNull: true },
    // Ordered palette of `{ hex, label? }` taken from the owner's logo — position
    // is the meaning (first = primary), matching how brand_series orders its
    // colours. Custom hex, not refs into the curated `colors` taxonomy.
    brand_colors:  jsonColumn('brand_colors', { allowNull: true }),
    // Stamp the owner's own logo/name on exported designs. A paid feature — the
    // service refuses to enable it without the `custom_watermark` entitlement.
    // The stamping itself happens in the app; this is only the preference.
    watermark_enabled: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    // Brand Kit typography. NAMED ROLES rather than an ordered list (unlike
    // brand_colors): templates bind type by role, and "the second font" means
    // nothing to a renderer.
    heading_font_id: { type: DataTypes.INTEGER, allowNull: true },
    body_font_id:    { type: DataTypes.INTEGER, allowNull: true },
    // "Active Frames" — the one frame from the owner's shelf applied to this
    // business's designs. Points at `frames` (not `user_frames`) so the editor
    // resolves the design payload in one hop; the service refuses to set it to
    // anything the owner does not own.
    active_frame_id: { type: DataTypes.INTEGER, allowNull: true },
    latitude:      { type: DataTypes.DECIMAL(10, 8), allowNull: true },
    longitude:     { type: DataTypes.DECIMAL(11, 8), allowNull: true },
    geohash:       { type: DataTypes.STRING(12), allowNull: true },
    address:       { type: DataTypes.TEXT, allowNull: true },
    city:          { type: DataTypes.STRING(100), allowNull: true },
    state:         { type: DataTypes.STRING(100), allowNull: true },
    phone:           { type: DataTypes.STRING(20), allowNull: true },
    whatsapp:        { type: DataTypes.STRING(20), allowNull: true },
    email:           { type: DataTypes.STRING(150), allowNull: true },
    website:         { type: DataTypes.STRING(255), allowNull: true },
    social_links:    jsonColumn('social_links',    { allowNull: true }),
    operating_hours: jsonColumn('operating_hours', { allowNull: true }),
    rating_avg:      { type: DataTypes.DECIMAL(2, 1), allowNull: false, defaultValue: 0 },
    rating_count:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    is_active:     { type: DataTypes.TINYINT, defaultValue: 1 },
  }, { tableName: 'businesses' });

  Business.associate = (models) => {
    Business.belongsTo(models.User,             { foreignKey: 'user_id' });
    Business.belongsTo(models.BusinessCategory, { foreignKey: 'category_id' });
    Business.hasMany(models.Product,            { foreignKey: 'business_id' });
    // "My Keywords" — the owner's picks from the shared tag taxonomy.
    Business.belongsToMany(models.Tag,          { through: models.BusinessTag, foreignKey: 'business_id' });
    Business.belongsTo(models.Font,             { as: 'headingFont', foreignKey: 'heading_font_id' });
    Business.belongsTo(models.Font,             { as: 'bodyFont',    foreignKey: 'body_font_id' });
    Business.belongsTo(models.Frame,            { as: 'activeFrame', foreignKey: 'active_frame_id' });
  };

  return Business;
};
