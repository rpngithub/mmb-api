'use strict';

const { v4: uuid } = require('uuid');

// Sample premium (plan-scoped) variants, so GET /variants/{uid} is exercisable end-to-end.
// References baseline ids: plans (2 = Pro, 3 = All-Access Pass) and business
// categories (1..5). Fixed high ids (9xxx) keep this demo data easy to remove and
// clear of the auto-increment ranges used by real/admin-created rows.
//
// - Variant 9001 "Golden Diwali"  → entitled plans [Pro], industries [1,2], badge Popular
// - Variant 9002 "Corporate Deck" → entitled plans [Pro, All-Access Pass], industries [4,5]
// A variant's templates load only for a user whose ACTIVE subscription plan is listed.
// Gating is per-VARIANT: the parent brand series carries no entitlement of its own.
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

    await queryInterface.bulkInsert('brand_series', [
      { id: 9001, uid: uuid(), name: 'Premium Picks', slug: 'premium-picks',
        caption: 'Hand-picked looks that sell',
        description: 'A curated set of premium brand looks, ready to publish across every channel.',
        display_order: 10, is_active: 1 },
    ]);

    await queryInterface.bulkInsert('style_personalities', [
      { id: 9001, uid: uuid(), name: 'Bold',      slug: 'bold',      display_order: 1, is_active: 1 },
      { id: 9002, uid: uuid(), name: 'Premium',   slug: 'premium',   display_order: 2, is_active: 1 },
      { id: 9003, uid: uuid(), name: 'Confident', slug: 'confident', display_order: 3, is_active: 1 },
    ]);

    await queryInterface.bulkInsert('colors', [
      { id: 9001, uid: uuid(), name: 'Black',    slug: 'black',    hex_code: '#000000', display_order: 1, is_active: 1 },
      { id: 9002, uid: uuid(), name: 'Charcoal', slug: 'charcoal', hex_code: '#36454F', display_order: 2, is_active: 1 },
      { id: 9003, uid: uuid(), name: 'Gold',     slug: 'gold',     hex_code: '#D4AF37', display_order: 3, is_active: 1 },
    ]);

    await queryInterface.bulkInsert('variant_badges', [
      { id: 9001, uid: uuid(), name: 'Popular', slug: 'popular', display_order: 1, is_active: 1 },
      { id: 9002, uid: uuid(), name: 'Fresh',   slug: 'fresh',   display_order: 2, is_active: 1 },
    ]);

    await queryInterface.bulkInsert('variants', [
      { id: 9001, uid: uuid(), series_id: 9001, badge_id: 9001, name: 'Golden Diwali',
        description: 'Warm, festive layouts with a gold-on-maroon palette. Ready to publish for the season.',
        likes_count: 1200, display_order: 1, is_active: 1 },
      { id: 9002, uid: uuid(), series_id: 9001, badge_id: null, name: 'Corporate Deck',
        description: 'Clean, professional templates for announcements, hiring, and milestones.',
        likes_count: 340, display_order: 2, is_active: 1 },
    ]);

    await queryInterface.bulkInsert('templates', [
      { id: 9001, uid: uuid(), name: 'Diwali Greeting',  content: '{"sample":"diwali-1"}',  status: 'active', is_premium: 1 },
      { id: 9002, uid: uuid(), name: 'Diwali Sale',      content: '{"sample":"diwali-2"}',  status: 'active', is_premium: 1 },
      { id: 9003, uid: uuid(), name: 'We Are Hiring',    content: '{"sample":"corp-1"}',    status: 'active', is_premium: 1 },
    ]);

    // variant <-> template assignments
    await queryInterface.bulkInsert('variant_templates', [
      { variant_id: 9001, template_id: 9001 },
      { variant_id: 9001, template_id: 9002 },
      { variant_id: 9002, template_id: 9003 },
    ]);

    // entitlement: which plans unlock each variant's templates
    await queryInterface.bulkInsert('variant_plan_restrictions', [
      { variant_id: 9001, plan_id: proId },        // Golden Diwali → Pro
      { variant_id: 9002, plan_id: proId },        // Corporate Deck → Pro
      { variant_id: 9002, plan_id: passId },       //                → All-Access Pass
    ]);

    // display/filter industry tags shown on the variant card
    await queryInterface.bulkInsert('variant_industries', [
      { variant_id: 9001, business_category_id: 1 },
      { variant_id: 9001, business_category_id: 2 },
      { variant_id: 9002, business_category_id: 4 },
      { variant_id: 9002, business_category_id: 5 },
    ]);

    // descriptive collections on the series (ordered ones carry display_order)
    await queryInterface.bulkInsert('brand_series_style_personalities', [
      { brand_series_id: 9001, style_personality_id: 9001, display_order: 0 },
      { brand_series_id: 9001, style_personality_id: 9002, display_order: 1 },
      { brand_series_id: 9001, style_personality_id: 9003, display_order: 2 },
    ]);

    await queryInterface.bulkInsert('brand_series_colors', [
      { brand_series_id: 9001, color_id: 9001, display_order: 0 },
      { brand_series_id: 9001, color_id: 9002, display_order: 1 },
      { brand_series_id: 9001, color_id: 9003, display_order: 2 },
    ]);
  },

  async down(queryInterface) {
    const { Op } = require('sequelize');
    const variantIds = { variant_id: { [Op.in]: [9001, 9002] } };
    const seriesIds  = { brand_series_id: { [Op.in]: [9001] } };
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryInterface.bulkDelete('variant_industries',        variantIds, {});
    await queryInterface.bulkDelete('variant_plan_restrictions', variantIds, {});
    await queryInterface.bulkDelete('variant_templates',         variantIds, {});
    await queryInterface.bulkDelete('brand_series_style_personalities', seriesIds, {});
    await queryInterface.bulkDelete('brand_series_colors',       seriesIds, {});
    await queryInterface.bulkDelete('brand_series_tags',         seriesIds, {});
    await queryInterface.bulkDelete('templates',           { id: { [Op.in]: [9001, 9002, 9003] } }, {});
    await queryInterface.bulkDelete('variants',            { id: { [Op.in]: [9001, 9002] } }, {});
    await queryInterface.bulkDelete('variant_badges',      { id: { [Op.in]: [9001, 9002] } }, {});
    await queryInterface.bulkDelete('style_personalities', { id: { [Op.in]: [9001, 9002, 9003] } }, {});
    await queryInterface.bulkDelete('colors',              { id: { [Op.in]: [9001, 9002, 9003] } }, {});
    await queryInterface.bulkDelete('brand_series',        { id: { [Op.in]: [9001] } }, {});
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  },
};
