'use strict';

const bcrypt       = require('bcryptjs');
const { v4: uuid } = require('uuid');

// Default super-admin credentials (development). Change in non-dev environments.
const ADMIN_EMAIL    = 'admin@makemybrand.com';
const ADMIN_PASSWORD = 'Admin@123';

module.exports = {
  async up(queryInterface) {
    // --- roles ---
    await queryInterface.bulkInsert('roles', [
      { id: 1, uid: uuid(), name: 'super_admin', description: 'Full access', permissions: JSON.stringify(['*']), is_system: 1 },
      { id: 2, uid: uuid(), name: 'content_admin', description: 'Manages catalog content',
        permissions: JSON.stringify(['templates.*', 'categories.*', 'variants.*', 'brand_series.*', 'assets.*', 'events.*', 'faqs.*', 'testimonials.*', 'banners.*', 'tags.*', 'sizes.*']), is_system: 1 },
    ]);

    // --- admin user ---
    const password_hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await queryInterface.bulkInsert('admin_users', [
      { id: 1, uid: uuid(), name: 'Super Admin', email: ADMIN_EMAIL, password_hash, role_id: 1, is_active: 1 },
    ]);

    // --- plans ---
    await queryInterface.bulkInsert('plans', [
      { id: 1, uid: uuid(), name: 'Free', description: 'Get started for free', plan_type: 'subscription', is_popular: 0, status: 'active', display_order: 1 },
      { id: 2, uid: uuid(), name: 'Pro',  description: 'For growing businesses', plan_type: 'subscription', trial_days: 15, is_popular: 1, status: 'active', display_order: 2 },
      // One-time ₹10 access pass: all features unlimited for pass_days, then expires.
      { id: 3, uid: uuid(), name: 'All-Access Pass', description: 'Try all features for 10 days', plan_type: 'access_pass', pass_price: 10.00, pass_days: 10, is_popular: 0, status: 'active', display_order: 99 },
    ]);

    // --- plan billing options (Pro only) ---
    await queryInterface.bulkInsert('plan_billing_options', [
      { id: 1, plan_id: 2, billing_cycle: 'monthly', price: 299.00,  discounted_price: null,    currency: 'INR', is_active: 1 },
      { id: 2, plan_id: 2, billing_cycle: 'annual',  price: 2999.00, discounted_price: 2399.00, discount_label: 'Save 20%', currency: 'INR', is_active: 1 },
    ]);

    // --- feature types (keys consumed by quotaCheck middleware) ---
    await queryInterface.bulkInsert('feature_types', [
      { id: 1, key: 'downloads',      label: 'Downloads',      reset_period: 'monthly', data_type: 'integer' },
      { id: 2, key: 'shares',         label: 'Shares',         reset_period: 'monthly', data_type: 'integer' },
      { id: 3, key: 'ai_credits',     label: 'AI Credits',     reset_period: 'monthly', data_type: 'integer' },
      { id: 4, key: 'template_views', label: 'Template Views', reset_period: 'never',   data_type: 'integer' },
      { id: 5, key: 'storage',        label: 'Storage (MB)',   reset_period: 'never',   data_type: 'integer' },
    ]);

    // --- plan features (value -1 = unlimited) ---
    await queryInterface.bulkInsert('plan_features', [
      // Free
      { plan_id: 1, feature_type_id: 1, value: 10,  display_label: '10 downloads / month',  display_order: 1, show_on_card: 1 },
      { plan_id: 1, feature_type_id: 2, value: 20,  display_label: '20 shares / month',     display_order: 2, show_on_card: 1 },
      { plan_id: 1, feature_type_id: 3, value: 5,   display_label: '5 AI credits / month',  display_order: 3, show_on_card: 1 },
      { plan_id: 1, feature_type_id: 4, value: -1,  display_label: 'Unlimited browsing',    display_order: 4, show_on_card: 0 },
      { plan_id: 1, feature_type_id: 5, value: 100, display_label: '100 MB storage',        display_order: 5, show_on_card: 1 },
      // Pro (all unlimited)
      { plan_id: 2, feature_type_id: 1, value: -1, display_label: 'Unlimited downloads', display_order: 1, show_on_card: 1 },
      { plan_id: 2, feature_type_id: 2, value: -1, display_label: 'Unlimited shares',    display_order: 2, show_on_card: 1 },
      { plan_id: 2, feature_type_id: 3, value: -1, display_label: 'Unlimited AI credits', display_order: 3, show_on_card: 1 },
      { plan_id: 2, feature_type_id: 4, value: -1, display_label: 'Unlimited browsing',  display_order: 4, show_on_card: 0 },
      { plan_id: 2, feature_type_id: 5, value: -1, display_label: 'Unlimited storage',   display_order: 5, show_on_card: 1 },
      // All-Access Pass (all unlimited)
      { plan_id: 3, feature_type_id: 1, value: -1, display_label: 'Unlimited downloads',  display_order: 1, show_on_card: 0 },
      { plan_id: 3, feature_type_id: 2, value: -1, display_label: 'Unlimited shares',     display_order: 2, show_on_card: 0 },
      { plan_id: 3, feature_type_id: 3, value: -1, display_label: 'Unlimited AI credits', display_order: 3, show_on_card: 0 },
      { plan_id: 3, feature_type_id: 4, value: -1, display_label: 'Unlimited browsing',   display_order: 4, show_on_card: 0 },
      { plan_id: 3, feature_type_id: 5, value: -1, display_label: 'Unlimited storage',    display_order: 5, show_on_card: 0 },
    ]);

    // --- business categories (top level) ---
    // slug is the public friendly filter key (see catalogRef); keep it in sync with name.
    await queryInterface.bulkInsert('business_categories', [
      { id: 1, uid: uuid(), parent_id: null, name: 'Restaurant & Food',  slug: 'restaurant-food',  display_order: 1, is_active: 1 },
      { id: 2, uid: uuid(), parent_id: null, name: 'Retail & Shopping',  slug: 'retail-shopping',  display_order: 2, is_active: 1 },
      { id: 3, uid: uuid(), parent_id: null, name: 'Salon & Spa',        slug: 'salon-spa',        display_order: 3, is_active: 1 },
      { id: 4, uid: uuid(), parent_id: null, name: 'Real Estate',        slug: 'real-estate',      display_order: 4, is_active: 1 },
      { id: 5, uid: uuid(), parent_id: null, name: 'Education',          slug: 'education',        display_order: 5, is_active: 1 },
    ]);

    // --- template categories ---
    await queryInterface.bulkInsert('template_categories', [
      { id: 1, uid: uuid(), parent_id: null, name: 'Festivals & Events', slug: 'festivals-events',  show_in_homepage: 1, display_order: 1, is_active: 1 },
      { id: 2, uid: uuid(), parent_id: null, name: 'Business Promotion', slug: 'business-promotion', show_in_homepage: 1, display_order: 2, is_active: 1 },
      { id: 3, uid: uuid(), parent_id: null, name: 'Sale & Offers',      slug: 'sale-offers',       show_in_homepage: 1, display_order: 3, is_active: 1 },
      { id: 4, uid: uuid(), parent_id: null, name: 'Greetings',          slug: 'greetings',         show_in_homepage: 0, display_order: 4, is_active: 1 },
    ]);

    // --- public app settings (consumed by GET /config) ---
    await queryInterface.bulkInsert('app_settings', [
      { key: 'app_name',          value: 'MakeMyBrand',            type: 'string',  group: 'general', is_public: 1, description: 'Public app name' },
      { key: 'support_email',     value: 'support@makemybrand.com', type: 'string',  group: 'general', is_public: 1, description: 'Support contact email' },
      { key: 'app_version',       value: '1.0.0',                  type: 'string',  group: 'general', is_public: 1, description: 'Current app version' },
      { key: 'min_supported_version', value: '1.0.0',              type: 'string',  group: 'general', is_public: 1, description: 'Minimum supported client version' },
      { key: 'maintenance_mode',  value: 'false',                  type: 'boolean', group: 'general', is_public: 1, description: 'Maintenance flag' },
      { key: 'gst_rate',          value: '18',                     type: 'integer', group: 'billing', is_public: 0, description: 'GST percentage' },
    ]);
  },

  async down(queryInterface) {
    const tables = [
      'app_settings', 'template_categories', 'business_categories', 'plan_features',
      'feature_types', 'plan_billing_options', 'plans', 'admin_users', 'roles',
    ];
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of tables) {
      await queryInterface.bulkDelete(t, null, {});
    }
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  },
};
