'use strict';

const { v4: uuid } = require('uuid');

/**
 * The notification catalogue from MMB_Notification_Master_v2.xlsx — 10 categories
 * and 43 templates.
 *
 * A MIGRATION, not a seeder, for one reason: seeders run only via `npm run seed`,
 * while boot runs migrations (RUN_MIGRATIONS_ON_BOOT). A missing template row makes
 * its dispatch call site a silent no-op — nothing errors, users simply stop being
 * told things — which is the worst failure mode this feature has. Migrations are
 * the only mechanism that guarantees the rows exist wherever the code does.
 *
 * IDEMPOTENT and NON-DESTRUCTIVE. Rows are inserted with INSERT IGNORE keyed on
 * `code`, and there is deliberately NO ON DUPLICATE KEY UPDATE on any copy column:
 * re-running this must be able to add a new code without clobbering wording an
 * admin has since edited in the panel. Same additive discipline as
 * 20260101000029-role-permissions-frames.js.
 *
 * Copy is verbatim from the sheet, with one class of change: where the sheet gives
 * a worked EXAMPLE rather than fixed wording — "Only 20 AI credits remaining",
 * "Diwali is tomorrow", "your 7-day trial" — the varying part becomes a
 * `{{placeholder}}` and is declared in `variables`. Sending a hard-coded "20" to
 * someone with 3 credits left would be worse than not sending at all.
 *
 * FIVE TEMPLATES ARE SEEDED INACTIVE. They describe features the schema cannot
 * express yet (there is no business publish/approval workflow, and no per-user
 * marketing calendar), so they are `manual` + `is_active = 0`: the copy is
 * preserved and an admin can still fire them as a campaign, but nothing pretends
 * they auto-fire. Flip them on when the backing feature lands.
 */

// ---------------------------------------------------------------------------

const CATEGORIES = [
  ['billing',     'Subscription & Billing', 'credit-card', 'Trials, payments, renewals and expiry'],
  ['credits',     'AI Credits',             'sparkles',    'Credit balance and monthly refreshes'],
  ['calendar',    'Marketing Calendar',     'calendar',    'Festivals, special days and content planning'],
  ['templates',   'Templates',              'layout',      'New collections and industry releases'],
  ['onboarding',  'Onboarding',             'compass',     'Getting set up and creating a first design'],
  ['retention',   'Retention',              'heart',       'Win-backs for users who have been away'],
  ['business',    'Business Profile',       'briefcase',   'Completing and publishing a business profile'],
  ['system',      'System',                 'settings',    'App updates and service notices'],
  ['engagement',  'Engagement',             'award',       'Milestones and achievements'],
  ['promotions',  'Promotions',             'tag',         'Offers, trending picks and inspiration'],
];

// [code, category, title, body, cta_label, cta_action, trigger_type, opts]
//
// opts: promo (is_promotional), acct (audience_account_type), plan (audience_plan),
//       cool (cooldown_hours), maxn (max_occurrences), prio (send priority),
//       disp (display_priority), exp (expires_after_days), vars, defs,
//       cfg (trigger_config), off (seed inactive)
const T = [
  // ---- Subscription & Billing -------------------------------------------
  ['trial_activated', 'billing', 'Trial Activated',
    '🎉 Welcome! Your {{trial_days}}-day {{plan_name}} trial has started.',
    'Explore Premium', 'subscription.plans', 'event',
    { disp: 'high', vars: ['trial_days', 'plan_name'], defs: { plan_name: 'Premium' } }],

  ['trial_ending_tomorrow', 'billing', 'Trial Ending Tomorrow',
    'Your {{plan_name}} trial ends tomorrow.',
    'Upgrade Now', 'subscription.plans', 'scheduled',
    { disp: 'high', exp: 3, vars: ['plan_name'], defs: { plan_name: 'Premium' },
      cfg: { anchor: 'trial_end', offset_days: -1 } }],

  ['payment_successful', 'billing', 'Payment Successful',
    'Your {{plan_name}} plan is now active.',
    'View Invoice', 'billing.invoices', 'event',
    { vars: ['plan_name'], defs: { plan_name: 'Premium' } }],

  ['payment_failed', 'billing', 'Payment Failed',
    "We couldn't process your payment.",
    'Retry Payment', 'billing.retry', 'event', { disp: 'high' }],

  ['subscription_expiring', 'billing', 'Subscription Expiring',
    'Your subscription expires in {{days_count}} days.',
    'Renew Now', 'subscription.plans', 'scheduled',
    { disp: 'high', exp: 5, vars: ['days_count'], defs: { days_count: '2' },
      cfg: { anchor: 'subscription_end', offset_days: -2 } }],

  ['subscription_renewed', 'billing', 'Subscription Renewed',
    'Your subscription has been renewed successfully.',
    'View Plan', 'subscription.mine', 'event', {}],

  // ---- AI Credits ---------------------------------------------------------
  ['credits_running_low', 'credits', 'Credits Running Low',
    'Only {{credits_count}} AI credits remaining.',
    'Upgrade Plan', 'subscription.plans', 'event',
    { vars: ['credits_count'] }],

  ['credits_reset', 'credits', 'Credits Reset',
    'Your monthly AI credits have been refreshed.',
    'Explore AI Tools', 'ai.tools', 'event', { exp: 14 }],

  ['free_credits_refreshed', 'credits', 'Free AI Credits Refreshed',
    '🎁 Your free AI credits have been refreshed.',
    'Start Creating', 'ai.tools', 'event',
    { acct: 'personal', plan: 'free', exp: 14 }],

  // ---- Marketing Calendar (business audience) -----------------------------
  ['festival_tomorrow_business', 'calendar', 'Festival Tomorrow',
    '🎉 {{event_name}} is tomorrow. Ready-made templates are waiting.',
    'Create Post', 'events.detail', 'scheduled',
    { promo: 1, acct: 'business', exp: 2, prio: 70, vars: ['event_name'],
      cfg: { anchor: 'special_event', offset_days: -1 } }],

  ['festival_today_business', 'calendar', 'Festival Today',
    'Wish your audience today.',
    'Explore Templates', 'events.detail', 'scheduled',
    { promo: 1, acct: 'business', exp: 1, prio: 70,
      cfg: { anchor: 'special_event', offset_days: 0 } }],

  ['weekly_marketing_reminder', 'calendar', 'Weekly Marketing Reminder',
    'Your content plan for this week is ready.',
    'View Calendar', 'calendar.home', 'manual',
    { promo: 1, acct: 'business', cool: 168, off: 1 }],

  ['monthly_calendar_ready', 'calendar', 'Monthly Calendar Ready',
    'Your monthly marketing calendar is ready.',
    'Open Calendar', 'calendar.home', 'manual',
    { promo: 1, acct: 'business', off: 1 }],

  // ---- Templates ----------------------------------------------------------
  ['new_brand_series_business', 'templates', 'New Brand Series',
    'A new Brand Series has been added for your industry.',
    'Explore Now', 'brandSeries.browse', 'event',
    { promo: 1, acct: 'business', exp: 21 }],

  ['industry_templates_released', 'templates', 'Industry Templates',
    'New industry templates are now available.',
    'View Templates', 'templates.browse', 'manual',
    { promo: 1, acct: 'business', exp: 21 }],

  // ---- Onboarding ---------------------------------------------------------
  ['welcome_to_mmb', 'onboarding', 'Welcome to MMB',
    "🎉 Welcome to Make My Brand! Let's create your first design in just a few minutes.",
    'Get Started', 'home', 'event', { disp: 'high', prio: 100 }],

  ['complete_your_profile', 'onboarding', 'Complete Your Profile',
    'Complete your profile to unlock a personalized MMB experience.',
    'Complete Profile', 'profile.edit', 'behavioral',
    { promo: 1, prio: 90, maxn: 3, cool: 168,
      cfg: { predicate: 'onboarding_incomplete', min_days: 1, max_days: 7 } }],

  ['business_profile_not_created', 'onboarding', 'Business Profile Not Created',
    'Ready to grow your business? Create your Business Profile and unlock industry-specific templates.',
    'Set Up My Business', 'business.create', 'behavioral',
    { promo: 1, acct: 'personal', prio: 80, maxn: 3, cool: 336,
      cfg: { predicate: 'no_business_profile', min_days: 3, max_days: 7 } }],

  ['no_first_design_created', 'onboarding', 'No First Design Created',
    'Your first design is just a few taps away. Start creating today.',
    'Create Design', 'templates.browse', 'behavioral',
    { promo: 1, prio: 85, maxn: 3, cool: 168,
      cfg: { predicate: 'no_projects', min_days: 1, max_days: 4 } }],

  // ---- Retention ----------------------------------------------------------
  ['never_returned_3d', 'retention', 'App Installed but Never Returned',
    'We saved everything for you. Come back and continue creating.',
    'Open App', 'home', 'behavioral',
    { promo: 1, prio: 75, cfg: { predicate: 'never_returned', days: 3, window_days: 3 } }],

  ['inactive_7d', 'retention', 'Inactive User - 7 Days',
    'We miss you! Discover new templates and AI tools waiting for you.',
    'Explore Now', 'templates.browse', 'behavioral',
    { promo: 1, prio: 60, cfg: { predicate: 'inactive', days: 7, window_days: 3 } }],

  ['inactive_15d', 'retention', 'Inactive User - 15 Days',
    'New templates and features have been added since your last visit.',
    'See What’s New', 'templates.browse', 'behavioral',
    { promo: 1, prio: 60, cfg: { predicate: 'inactive', days: 15, window_days: 3 } }],

  ['inactive_30d', 'retention', 'Inactive User - 30 Days',
    "It's been a while! Come back and start creating again.",
    'Open MMB', 'home', 'behavioral',
    { promo: 1, prio: 60, cfg: { predicate: 'inactive', days: 30, window_days: 3 } }],

  // ---- Business Profile ---------------------------------------------------
  ['incomplete_business_setup', 'business', 'Incomplete Business Setup',
    'Complete your business profile to unlock personalized templates.',
    'Continue Setup', 'business.edit', 'behavioral',
    { promo: 1, acct: 'business', prio: 70, maxn: 4, cool: 336,
      cfg: { predicate: 'business_incomplete', window_days: 3 } }],

  ['logo_missing', 'business', 'Logo Missing',
    'Upload your logo to personalize every design automatically.',
    'Upload Logo', 'business.brandKit', 'behavioral',
    { promo: 1, acct: 'business', prio: 65, maxn: 4, cool: 336,
      cfg: { predicate: 'no_logo', window_days: 3 } }],

  ['brand_frame_not_configured', 'business', 'Brand Frame Not Configured',
    'Set up your Brand Frame once and apply it to every design automatically.',
    'Configure Now', 'business.frames', 'behavioral',
    { promo: 1, acct: 'business', prio: 55, maxn: 3, cool: 336,
      cfg: { predicate: 'no_active_frame', window_days: 3 } }],

  ['products_not_added', 'business', 'Products Not Added',
    'Showcase your products and make your designs more engaging.',
    'Add Products', 'products.create', 'behavioral',
    { promo: 1, acct: 'business', prio: 55, maxn: 3, cool: 336,
      cfg: { predicate: 'no_products', window_days: 3 } }],

  ['content_preferences_missing', 'business', 'Content Preferences Missing',
    'Choose your content preferences to receive smarter template recommendations.',
    'Update Preferences', 'business.keywords', 'behavioral',
    { promo: 1, acct: 'business', prio: 50, maxn: 3, cool: 336,
      cfg: { predicate: 'no_business_tags', window_days: 3 } }],

  ['business_listing_not_published', 'business', 'Business Listing Not Published',
    'Your business profile is almost ready. Publish it to reach more customers.',
    'Publish Profile', 'business.edit', 'manual',
    { promo: 1, acct: 'business', off: 1 }],

  ['business_profile_approved', 'business', 'Business Profile Approved',
    'Your business profile has been approved.',
    'View Profile', 'business.mine', 'manual',
    { acct: 'business', disp: 'high', off: 1 }],

  // ---- System -------------------------------------------------------------
  // The sheet's only System row. The Personal-User "App Update" is a separate row
  // with its own copy — see `app_update_personal` under Promotions.
  ['download_app_update', 'system', 'Download App Update',
    'A better MMB experience is available. Update now.',
    'Update App', 'system.update', 'manual', { off: 1 }],

  // ---- Engagement ---------------------------------------------------------
  ['first_design_created', 'engagement', 'First Achievement',
    'Congratulations! You created your first design. Keep creating.',
    'Celebrate', 'projects.mine', 'event', { disp: 'high', prio: 95 }],

  // ---- Promotions (personal-user set) -------------------------------------
  ['festival_tomorrow_personal', 'promotions', 'Festival Reminder',
    '🎉 A festival is tomorrow! Create and share beautiful wishes in minutes.',
    'Explore Templates', 'events.detail', 'scheduled',
    { promo: 1, acct: 'personal', exp: 2, prio: 70,
      cfg: { anchor: 'special_event', offset_days: -1 } }],

  ['festival_today_personal', 'promotions', 'Festival Today',
    'Celebrate today with ready-made templates for your friends and family.',
    'Create Post', 'events.detail', 'scheduled',
    { promo: 1, acct: 'personal', exp: 1, prio: 70,
      cfg: { anchor: 'special_event', offset_days: 0 } }],

  ['special_day_reminder', 'promotions', 'Special Day Reminder',
    'A special day is coming. Create a memorable post.',
    'View Templates', 'events.detail', 'scheduled',
    { promo: 1, acct: 'personal', exp: 2, prio: 65,
      cfg: { anchor: 'special_event', offset_days: -1, event_types: ['observance'] } }],

  ['trending_templates', 'promotions', 'Trending Templates',
    '🔥 New trending templates are now available.',
    'Explore', 'templates.trending', 'recurring',
    { promo: 1, acct: 'personal', cool: 168, exp: 7, prio: 40,
      cfg: { recurrence: 'weekly', weekday: 4 } }],

  ['ai_feature_promotion', 'promotions', 'AI Feature Promotion',
    '✨ Try our AI Image Generator and create amazing visuals in seconds.',
    'Try Now', 'ai.tools', 'recurring',
    { promo: 1, cool: 504, exp: 14, prio: 30,
      cfg: { recurrence: 'every_n_days', days: 21 } }],

  ['premium_promotion', 'promotions', 'Premium Promotion',
    'Unlock 2,000+ premium templates and powerful AI tools.',
    'Upgrade Now', 'subscription.plans', 'recurring',
    { promo: 1, plan: 'free', cool: 168, exp: 7, prio: 35,
      cfg: { recurrence: 'weekly', weekday: 6 } }],

  ['start_business_journey', 'promotions', 'Start Your Business Journey',
    'Ready to promote your business? Create your Business Profile and unlock industry-specific templates.',
    'Set Up My Business', 'business.create', 'behavioral',
    { promo: 1, acct: 'personal', cool: 288, maxn: 5, prio: 45,
      cfg: { predicate: 'still_personal', cycle_days: 12 } }],

  ['new_brand_series_personal', 'promotions', 'New Brand Series',
    '✨ A new Brand Series is now available.',
    'Explore', 'brandSeries.browse', 'event',
    { promo: 1, acct: 'personal', exp: 21, prio: 40 }],

  ['seasonal_collection', 'promotions', 'Seasonal Collection',
    '🌸 Explore our latest seasonal template collection.',
    'Explore', 'templates.browse', 'manual',
    { promo: 1, acct: 'personal', exp: 21, prio: 40 }],

  ['weekly_inspiration', 'promotions', 'Weekly Inspiration',
    "Need inspiration? Discover this week's most popular designs.",
    'Browse Templates', 'templates.trending', 'recurring',
    { promo: 1, acct: 'personal', cool: 168, exp: 7, prio: 25,
      cfg: { recurrence: 'weekly', weekday: 1 } }],

  ['app_update_personal', 'promotions', 'App Update',
    '✨ New AI features and improvements are now available.',
    'Try It', 'home', 'manual',
    { promo: 1, acct: 'personal', exp: 14, prio: 30 }],
];

// ---------------------------------------------------------------------------

module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    // Categories first — templates reference them by id.
    for (const [slug, name, icon, description] of CATEGORIES) {
      await sql.query(
        `INSERT IGNORE INTO notification_categories
           (uid, name, slug, description, icon, display_order, is_active, created_at, updated_at)
         VALUES (:uid, :name, :slug, :description, :icon, :ord, 1, NOW(), NOW())`,
        {
          replacements: {
            uid: uuid(), name, slug, description, icon,
            ord: CATEGORIES.findIndex((c) => c[0] === slug) + 1,
          },
        },
      );
    }

    const [catRows] = await sql.query('SELECT id, slug FROM notification_categories');
    const catId = new Map(catRows.map((r) => [r.slug, r.id]));

    for (const [code, category, title, body, ctaLabel, ctaAction, triggerType, o = {}] of T) {
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
            :variables, :defaults, :triggerType, :config,
            :acct, :plan, :channels,
            :priority, :display, :promo, :cooldown, :maxOcc,
            1, :expires, :active, 1,
            NOW(), NOW())`,
        {
          replacements: {
            uid:        uuid(),
            code,
            categoryId: catId.get(category) || null,
            title,
            body,
            ctaLabel:   ctaLabel || null,
            ctaAction:  ctaAction || null,
            variables:  JSON.stringify(o.vars || []),
            defaults:   o.defs ? JSON.stringify(o.defs) : null,
            triggerType,
            config:     o.cfg ? JSON.stringify(o.cfg) : null,
            acct:       o.acct || 'all',
            plan:       o.plan || 'all',
            channels:   JSON.stringify(['in_app']),
            priority:   o.prio !== undefined ? o.prio : 50,
            display:    o.disp || 'normal',
            promo:      o.promo ? 1 : 0,
            cooldown:   o.cool !== undefined ? o.cool : null,
            maxOcc:     o.maxn !== undefined ? o.maxn : null,
            expires:    o.exp !== undefined ? o.exp : null,
            active:     o.off ? 0 : 1,
          },
        },
      );
    }
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;
    const codes = T.map((t) => t[0]);

    // user_notifications.template_id is ON DELETE RESTRICT — deliberately, so that
    // retiring a template in normal operation cannot silently erase a user's
    // cooldown history. That makes the inbox rows a hard blocker here, so undoing
    // the seed has to remove what the seed caused first. Reversing a data seed by
    // deleting the data derived from it is the correct semantics, and migration
    // 033's own `down` drops the whole table a moment later anyway.
    await sql.query(
      `DELETE FROM user_notifications
        WHERE template_id IN (SELECT id FROM notification_templates WHERE code IN (:codes))`,
      { replacements: { codes } },
    );
    // Campaigns pin a template with RESTRICT for the same reason.
    await sql.query(
      `UPDATE notification_campaigns SET template_id = NULL
        WHERE template_id IN (SELECT id FROM notification_templates WHERE code IN (:codes))`,
      { replacements: { codes } },
    );

    // Only the seeded system rows, and only those still recognisable by code —
    // anything an admin authored afterwards is theirs and is left alone.
    await sql.query(
      'DELETE FROM notification_templates WHERE is_system = 1 AND code IN (:codes)',
      { replacements: { codes } },
    );
    await sql.query(
      'DELETE FROM notification_categories WHERE slug IN (:slugs)',
      { replacements: { slugs: CATEGORIES.map((c) => c[0]) } },
    );
  },
};
