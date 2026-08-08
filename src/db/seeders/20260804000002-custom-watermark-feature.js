'use strict';

// The `custom_watermark` entitlement: may this account stamp its own logo/name on
// exported designs?
//
// A BOOLEAN plan feature rather than a hardcoded "any paid plan" check, so it
// shows up in GET /subscriptions/me alongside every other entitlement (the app
// reads `enabled` the same way it reads the rest) and so a cheaper plan can be
// offered later without touching code.
//
// Free = off, Pro and All-Access = on. `show_on_card` is 1 on Pro because it is a
// reason to upgrade; 0 on Free, where advertising what you cannot do is noise.
//
// The id is resolved AFTER insert rather than hardcoded: the baseline seeder took
// 1-5, but anything may hold the next id by the time this runs (test fixtures, a
// feature added from the admin panel), and a fixed id collides with it.
const KEY = 'custom_watermark';

const PLAN_VALUES = [
  { plan_id: 1, value: 0, display_label: 'Custom watermark',       show_on_card: 0 },   // Free
  { plan_id: 2, value: 1, display_label: 'Add your own watermark', show_on_card: 1 },   // Pro
  { plan_id: 3, value: 1, display_label: 'Add your own watermark', show_on_card: 0 },   // All-Access
];

module.exports = {
  async up(queryInterface) {
    await queryInterface.bulkInsert('feature_types', [
      { key: KEY, label: 'Custom Watermark', reset_period: 'never', data_type: 'boolean' },
    ]);

    const [[row]] = await queryInterface.sequelize.query(
      'SELECT id FROM feature_types WHERE `key` = :key', { replacements: { key: KEY } },
    );

    await queryInterface.bulkInsert('plan_features', PLAN_VALUES.map((p) => ({
      plan_id:         p.plan_id,
      feature_type_id: row.id,
      value:           p.value,
      display_label:   p.display_label,
      display_order:   6,
      show_on_card:    p.show_on_card,
    })));
  },

  async down(queryInterface) {
    const [[row]] = await queryInterface.sequelize.query(
      'SELECT id FROM feature_types WHERE `key` = :key', { replacements: { key: KEY } },
    );
    if (!row) return;
    await queryInterface.bulkDelete('plan_features', { feature_type_id: row.id }, {});
    await queryInterface.bulkDelete('feature_types', { id: row.id }, {});
  },
};
