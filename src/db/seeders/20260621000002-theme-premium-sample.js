'use strict';

const { v4: uuid } = require('uuid');

// Sample premium (plan-scoped) themes, so GET /themes/{uid} is exercisable end-to-end.
// References baseline ids: plans (2 = Pro, 3 = All-Access Pass) and business
// categories (1..5). Fixed high ids (9xxx) keep this demo data easy to remove and
// clear of the auto-increment ranges used by real/admin-created rows.
//
// - Theme 9001 "Golden Diwali"  → entitled plans [Pro], business tags [1,2]
// - Theme 9002 "Corporate Deck" → entitled plans [Pro, All-Access Pass], tags [4,5]
// A theme's templates load only for a user whose ACTIVE subscription plan is listed.
module.exports = {
  async up(queryInterface) {
    // Resolve plan ids by name — auto-increment ids are not stable across environments
    // (tests/admins create & delete plans), so we must not hardcode them.
    const [plans] = await queryInterface.sequelize.query('SELECT id, name FROM plans');
    const planId  = (name) => (plans.find((p) => p.name === name) || {}).id;
    const proId   = planId('Pro');
    const passId  = planId('All-Access Pass');

    // Clean any leftovers from a previously interrupted run so up() is re-runnable.
    await this.down(queryInterface);

    await queryInterface.bulkInsert('theme_groups', [
      { id: 9001, uid: uuid(), name: 'Premium Picks', slug: 'premium-picks', display_order: 10, is_active: 1 },
    ]);

    await queryInterface.bulkInsert('themes', [
      { id: 9001, uid: uuid(), group_id: 9001, name: 'Golden Diwali',
        description: 'Warm, festive layouts with a gold-on-maroon palette. Ready to publish for the season.',
        likes_count: 1200, display_order: 1, is_active: 1 },
      { id: 9002, uid: uuid(), group_id: 9001, name: 'Corporate Deck',
        description: 'Clean, professional templates for announcements, hiring, and milestones.',
        likes_count: 340, display_order: 2, is_active: 1 },
    ]);

    await queryInterface.bulkInsert('templates', [
      { id: 9001, uid: uuid(), name: 'Diwali Greeting',  content: '{"sample":"diwali-1"}',  status: 'active', is_premium: 1 },
      { id: 9002, uid: uuid(), name: 'Diwali Sale',      content: '{"sample":"diwali-2"}',  status: 'active', is_premium: 1 },
      { id: 9003, uid: uuid(), name: 'We Are Hiring',    content: '{"sample":"corp-1"}',    status: 'active', is_premium: 1 },
    ]);

    // theme <-> template assignments
    await queryInterface.bulkInsert('theme_templates', [
      { theme_id: 9001, template_id: 9001 },
      { theme_id: 9001, template_id: 9002 },
      { theme_id: 9002, template_id: 9003 },
    ]);

    // entitlement: which plans unlock each theme's templates
    await queryInterface.bulkInsert('theme_plan_restrictions', [
      { theme_id: 9001, plan_id: proId },        // Golden Diwali → Pro
      { theme_id: 9002, plan_id: proId },        // Corporate Deck → Pro
      { theme_id: 9002, plan_id: passId },       //               → All-Access Pass
    ]);

    // display/filter tags shown on the theme card
    await queryInterface.bulkInsert('theme_business_categories', [
      { theme_id: 9001, business_category_id: 1 },
      { theme_id: 9001, business_category_id: 2 },
      { theme_id: 9002, business_category_id: 4 },
      { theme_id: 9002, business_category_id: 5 },
    ]);
  },

  async down(queryInterface) {
    const { Op } = require('sequelize');
    const themeIds = { theme_id: { [Op.in]: [9001, 9002] } };
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryInterface.bulkDelete('theme_business_categories', themeIds, {});
    await queryInterface.bulkDelete('theme_plan_restrictions',   themeIds, {});
    await queryInterface.bulkDelete('theme_templates',           themeIds, {});
    await queryInterface.bulkDelete('templates',    { id: { [Op.in]: [9001, 9002, 9003] } }, {});
    await queryInterface.bulkDelete('themes',       { id: { [Op.in]: [9001, 9002] } }, {});
    await queryInterface.bulkDelete('theme_groups', { id: { [Op.in]: [9001] } }, {});
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  },
};
