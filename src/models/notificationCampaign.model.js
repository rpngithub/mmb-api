const { DataTypes } = require('sequelize');
const { jsonColumn } = require('../utils/jsonColumn');

// An admin broadcast: "we shipped 2.4, tell everyone". Separate from a template
// because a campaign is a one-off EVENT with a lifecycle, an audience snapshot and
// a progress cursor — none of which belong on a reusable catalogue row.
module.exports = (sequelize) => {
  const NotificationCampaign = sequelize.define('NotificationCampaign', {
    id:  { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    // Internal label for the admin list; never shown to users.
    name:        { type: DataTypes.STRING(200), allowNull: false },
    // Optional: start from a catalogue template's copy, or write the whole thing
    // inline.
    template_id: { type: DataTypes.INTEGER, allowNull: true },
    category_id: { type: DataTypes.INTEGER, allowNull: true },

    title:        { type: DataTypes.STRING(200), allowNull: true },
    body:         { type: DataTypes.TEXT, allowNull: true },
    cta_label:    { type: DataTypes.STRING(100), allowNull: true },
    cta_action:   { type: DataTypes.STRING(100), allowNull: true },
    cta_params:   jsonColumn('cta_params', { allowNull: true }),
    image_s3_key: { type: DataTypes.STRING(500), allowNull: true },

    // Flat, AND-ed filter criteria — not a nested boolean tree, which an admin
    // could not audit from the panel and which this product does not need.
    // Whitelisted at save time; values only ever reach SQL as bind parameters.
    // ONE builder turns this into a WHERE for both the preview count and the
    // fan-out, so the number the admin approved is the set that actually ships.
    audience: jsonColumn('audience', { allowNull: true }),

    scheduled_at: { type: DataTypes.DATE, allowNull: true },
    status: {
      type: DataTypes.ENUM('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed'),
      allowNull: false, defaultValue: 'draft',
    },

    // Keyset resume point. Advanced AFTER the chunk's insert commits: a crash
    // between the two re-runs the chunk, whose rows all collide on
    // dedupe_key 'campaign:<id>'. The reverse order would skip those users forever.
    cursor_user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Snapshot of the preview count at schedule time, so the panel shows a stable
    // number rather than one that drifts between approving and sending.
    audience_count: { type: DataTypes.INTEGER, allowNull: true },
    sent_count:     { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Deliberately passed over — muted the category, failed the audience match, hit
    // a cap. Not errors: the admin needs to see that "sent 8,412 of 10,000" is the
    // expected outcome.
    skipped_count:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    failed_count:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Audited escape hatch for a genuine announcement (pricing change, outage).
    // Bypasses the fatigue caps only — never marketing consent.
    bypass_fatigue: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },

    started_at:    { type: DataTypes.DATE, allowNull: true },
    completed_at:  { type: DataTypes.DATE, allowNull: true },
    error_message: { type: DataTypes.STRING(500), allowNull: true },
    created_by:    { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'notification_campaigns' });

  NotificationCampaign.associate = (models) => {
    NotificationCampaign.belongsTo(models.NotificationTemplate, { foreignKey: 'template_id' });
    NotificationCampaign.belongsTo(models.NotificationCategory, { foreignKey: 'category_id' });
    NotificationCampaign.belongsTo(models.AdminUser,            { foreignKey: 'created_by', as: 'creator' });
    NotificationCampaign.hasMany(models.UserNotification,       { foreignKey: 'campaign_id' });
  };

  return NotificationCampaign;
};
