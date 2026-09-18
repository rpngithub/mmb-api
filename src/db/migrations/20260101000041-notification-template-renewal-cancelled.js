'use strict';

const { v4: uuid } = require('uuid');

/**
 * One more built-in notification: `renewal_cancelled`, sent when the user stops
 * their subscription from renewing (POST /subscriptions/me/cancel-renewal). It
 * confirms two things the user will otherwise wonder about — that no further
 * charge is coming, and that access continues until the paid term ends.
 *
 * A migration, not an edit to the 034 seed, for the reason 034 gives: that seed
 * has already run wherever it has run, and INSERT IGNORE on an existing table
 * would never add this row there. Same INSERT IGNORE discipline, so re-running
 * cannot clobber wording an admin has since changed.
 *
 * Transactional (not promotional): it is the receipt for an action the user
 * took, so it bypasses the fatigue caps and quiet hours. `variables` is the
 * supply list — what cancelRenewal actually passes in.
 */
const TEMPLATE = {
  code:       'renewal_cancelled',
  category:   'billing',
  title:      'Auto-Renewal Turned Off',
  body:       'Your {{plan_name}} plan will not renew. You can keep using it until {{access_until}}.',
  cta_label:  'View Plan',
  cta_action: 'subscription.mine',
  variables:  ['plan_name', 'access_until'],
  defaults:   { plan_name: 'Premium' },
};

module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;
    const [[cat]] = await sql.query(
      'SELECT id FROM notification_categories WHERE slug = :slug', { replacements: { slug: TEMPLATE.category } },
    );

    await sql.query(
      `INSERT IGNORE INTO notification_templates
         (uid, code, category_id, title, body, cta_label, cta_action,
          variables, variable_defaults, trigger_type, trigger_config,
          audience_account_type, audience_plan, channels,
          priority, display_priority, is_promotional, cooldown_hours, max_occurrences,
          is_dismissible, expires_after_days, is_active, is_system,
          created_at, updated_at)
       VALUES
         (:uid, :code, :categoryId, :title, :body, :ctaLabel, :ctaAction,
          :variables, :defaults, 'event', NULL,
          'all', 'all', :channels,
          50, 'normal', 0, NULL, NULL,
          1, NULL, 1, 1,
          NOW(), NOW())`,
      {
        replacements: {
          uid:        uuid(),
          code:       TEMPLATE.code,
          categoryId: cat ? cat.id : null,
          title:      TEMPLATE.title,
          body:       TEMPLATE.body,
          ctaLabel:   TEMPLATE.cta_label,
          ctaAction:  TEMPLATE.cta_action,
          variables:  JSON.stringify(TEMPLATE.variables),
          defaults:   JSON.stringify(TEMPLATE.defaults),
          channels:   JSON.stringify(['in_app']),
        },
      },
    );
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;
    // Same order as 034's down: inbox rows and campaigns pin the template with
    // ON DELETE RESTRICT, so they go (or are unpinned) first.
    await sql.query(
      `DELETE FROM user_notifications
        WHERE template_id IN (SELECT id FROM notification_templates WHERE code = :code)`,
      { replacements: { code: TEMPLATE.code } },
    );
    await sql.query(
      `UPDATE notification_campaigns SET template_id = NULL
        WHERE template_id IN (SELECT id FROM notification_templates WHERE code = :code)`,
      { replacements: { code: TEMPLATE.code } },
    );
    await sql.query(
      'DELETE FROM notification_templates WHERE is_system = 1 AND code = :code',
      { replacements: { code: TEMPLATE.code } },
    );
  },
};
