const { DataTypes } = require('sequelize');
const { jsonColumn } = require('../utils/jsonColumn');

// The inbox: one row per user per send, carrying a RENDERED SNAPSHOT of the copy.
//
// Snapshot rather than a reference to the template, for four reasons: "Only 20 AI
// credits remaining" was true when it was sent and re-rendering would make it lie
// about a past moment; the inbox is the most-polled endpoint in the app and
// re-rendering turns it into an N+1 across five tables; editing a template should
// affect FUTURE sends, not rewrite what users were already told; and a template can
// then be reworded or deactivated without touching a single existing row.
//
// `dedupe_key` + the UNIQUE (user_id, dedupe_key) index is the entire concurrency
// story for the feature — see the migration header (20260101000033).
module.exports = (sequelize) => {
  const UserNotification = sequelize.define('UserNotification', {
    id:  { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    uid: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, allowNull: false, unique: true },
    user_id:     { type: DataTypes.INTEGER, allowNull: false },
    template_id: { type: DataTypes.INTEGER, allowNull: true },
    campaign_id: { type: DataTypes.INTEGER, allowNull: true },
    category_id: { type: DataTypes.INTEGER, allowNull: true },

    // Identifies the OCCURRENCE, not the notification. Derived from state that is
    // frozen while the condition holds and moves when it breaks — which is what
    // lets a dormancy notification legitimately fire again after the user returns
    // and lapses a second time, while the same nightly scan running twice does not
    // produce two rows. See utils/dedupeKey.js.
    dedupe_key: { type: DataTypes.STRING(191), allowNull: false },

    // Denormalised from the template: every fatigue query filters on it, and
    // joining notification_templates in that path to read one TINYINT is silly.
    // Immutable per row, so there is nothing to keep in sync.
    is_promotional: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },

    title:        { type: DataTypes.STRING(200), allowNull: false },
    body:         { type: DataTypes.TEXT, allowNull: false },
    cta_label:    { type: DataTypes.STRING(100), allowNull: true },
    cta_action:   { type: DataTypes.STRING(100), allowNull: true },
    cta_params:   jsonColumn('cta_params', { allowNull: true }),
    image_s3_key: { type: DataTypes.STRING(500), allowNull: true },
    // The values actually substituted — "what exactly did we tell them", and the
    // input a later re-render pass would need for localisation.
    variables:    jsonColumn('variables', { allowNull: true }),

    priority:       { type: DataTypes.ENUM('low', 'normal', 'high'), allowNull: false, defaultValue: 'normal' },
    is_dismissible: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },

    // DELIVERY state, distinct from read/dismissed below. A notification decided
    // during quiet hours is inserted immediately as `scheduled` with a future
    // deliver_at, so an event retry collides on dedupe_key instead of queueing a
    // second copy; the dispatch job flips it to `delivered`.
    status:     { type: DataTypes.ENUM('scheduled', 'delivered'), allowNull: false, defaultValue: 'delivered' },
    deliver_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },

    read_at:      { type: DataTypes.DATE, allowNull: true },
    dismissed_at: { type: DataTypes.DATE, allowNull: true },
    expires_at:   { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'user_notifications',
    // Nothing updates an inbox row except read_at/dismissed_at, both of which are
    // their own timestamps — an updated_at would be pure write amplification on the
    // largest table in the schema. Same call as feedback.model.js.
    updatedAt: false,
  });

  UserNotification.associate = (models) => {
    UserNotification.belongsTo(models.User,                 { foreignKey: 'user_id' });
    UserNotification.belongsTo(models.NotificationTemplate, { foreignKey: 'template_id' });
    UserNotification.belongsTo(models.NotificationCampaign, { foreignKey: 'campaign_id' });
    UserNotification.belongsTo(models.NotificationCategory, { foreignKey: 'category_id' });
  };

  return UserNotification;
};
