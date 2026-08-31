const { DataTypes } = require('sequelize');
const { jsonColumn } = require('../utils/jsonColumn');

// The catalogue: what CAN be sent, and the rules for sending it. One row per
// notification in the product sheet, plus anything an admin authors later.
//
// `code` is the contract between this row and the service call site that
// dispatches it, and it prefixes every dedupe_key in user_notifications — so on a
// system row it is frozen, along with `trigger_type`, which decides which job owns
// the template. Both are enforced in the admin CRUD's beforeWrite gate.
module.exports = (sequelize) => {
  const NotificationTemplate = sequelize.define('NotificationTemplate', {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    uid:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    code:        { type: DataTypes.STRING(80), allowNull: false, unique: true },
    category_id: { type: DataTypes.INTEGER, allowNull: true },

    title:      { type: DataTypes.STRING(200), allowNull: false },
    body:       { type: DataTypes.TEXT, allowNull: false },
    cta_label:  { type: DataTypes.STRING(100), allowNull: true },
    // An app ROUTE KEY ('subscription.plans'), not a URL — every notification here
    // lands in-product, unlike app_banners which may point off-app.
    cta_action:   { type: DataTypes.STRING(100), allowNull: true },
    cta_params:   jsonColumn('cta_params', { allowNull: true }),
    image_s3_key: { type: DataTypes.STRING(500), allowNull: true },

    // The `{{token}}` contract, checked against the copy IN BOTH DIRECTIONS when an
    // admin saves: an undeclared token and an unused declaration are both rejected.
    // Catching it there is the point — the alternative is discovering the hole when
    // forty thousand people receive "Only {{credits}} AI credits remaining".
    variables:         jsonColumn('variables', { allowNull: true }),
    variable_defaults: jsonColumn('variable_defaults', { allowNull: true }),

    trigger_type: {
      type: DataTypes.ENUM('event', 'scheduled', 'behavioral', 'recurring', 'manual'),
      allowNull: false, defaultValue: 'manual',
    },
    // Per-family knobs: { anchor, offset_days } for scheduled, { predicate, days }
    // for behavioural, { recurrence } for recurring.
    trigger_config: jsonColumn('trigger_config', { allowNull: true }),

    // The sheet splits several notifications by who they are for — the personal
    // user's festival copy differs from the business owner's. Two templates with
    // distinct codes, filtered here, rather than one template with a fork inside.
    audience_account_type: {
      type: DataTypes.ENUM('all', 'business', 'personal'), allowNull: false, defaultValue: 'all',
    },
    audience_plan: {
      type: DataTypes.ENUM('all', 'free', 'paid', 'trial'), allowNull: false, defaultValue: 'all',
    },

    // Forward seam only. The send path asserts ["in_app"]; push and email add
    // values here plus a channel dispatcher, with no reshape of this table.
    channels: jsonColumn('channels', { allowNull: true }),

    // SEND-ORDER priority: which message wins when the daily cap bites. The scans
    // walk their templates in descending order, so the cap is spent on the most
    // valuable one rather than on whichever scan happened to run first.
    priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 50 },
    // DISPLAY priority, copied onto the inbox row — how the app renders it. A
    // separate column because it answers a different question from `priority`:
    // a message can sort last and still deserve to look urgent.
    display_priority: {
      type: DataTypes.ENUM('low', 'normal', 'high'), allowNull: false, defaultValue: 'normal',
    },

    // Marketing vs transactional. Bypasses both fatigue caps, the min-gap, the
    // cooldown, quiet hours and notify_marketing — a payment receipt is not
    // marketing and must land at 2am if that is when the payment failed.
    is_promotional: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },

    // "once a week (max)" -> 168. Hours rather than days so "occasionally" is
    // tunable without a migration. NULL = no cooldown.
    cooldown_hours: { type: DataTypes.INTEGER, allowNull: true },
    // Lifetime cap per user — "Start Your Business Journey" gives up after three
    // attempts instead of nagging forever.
    max_occurrences: { type: DataTypes.INTEGER, allowNull: true },

    is_dismissible:     { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    expires_after_days: { type: DataTypes.INTEGER, allowNull: true },
    is_active:          { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    // Seeded from the product sheet. Copy, CTA, throttle and the active toggle stay
    // editable; `code` and `trigger_type` do not. Deletion goes through adminCrud's
    // softDelete, which flips is_active rather than destroying the row.
    is_system:          { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    created_by:         { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'notification_templates' });

  NotificationTemplate.associate = (models) => {
    NotificationTemplate.belongsTo(models.NotificationCategory, { foreignKey: 'category_id' });
    NotificationTemplate.belongsTo(models.AdminUser,            { foreignKey: 'created_by', as: 'creator' });
    NotificationTemplate.hasMany(models.UserNotification,       { foreignKey: 'template_id' });
    NotificationTemplate.hasMany(models.NotificationCampaign,   { foreignKey: 'template_id' });
  };

  return NotificationTemplate;
};
