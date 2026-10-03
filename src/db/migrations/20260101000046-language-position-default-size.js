'use strict';

/**
 * Two knobs the template-family feed needs.
 *
 *   user_languages.position  the ORDER the user ranked their Preferred Languages
 *                            in. The first is the language a design's card is
 *                            shown in, the next ones are fallbacks. Until now
 *                            the set was unordered and read back in the global
 *                            languages.display_order, so existing users are
 *                            backfilled in exactly that order — nobody's feed
 *                            changes on deploy. (`position`, not `order`: ORDER
 *                            is a reserved word.)
 *
 *   app_settings.default_template_size
 *                            slug of the size a family's card prefers, and the
 *                            size a family must have (in English) to publish.
 *                            Admin-editable without a deploy; public, so the app
 *                            can read it from GET /config. Seeded with the
 *                            1080×1350 (4:5) size when one exists, else empty —
 *                            then no size is preferred and the publish gate
 *                            asks only for an English version.
 */
const SETTING_KEY = 'default_template_size';

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;

    const [cols] = await qi.sequelize.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'user_languages' AND column_name = 'position'`);
    if (!Number(cols[0].n)) {
      await qi.addColumn('user_languages', 'position', {
        type: Sequelize.INTEGER, allowNull: false, defaultValue: 0, after: 'language_id',
      });

      // Backfill in JS: no window functions, so it runs on any MySQL/MariaDB.
      const [rows] = await qi.sequelize.query(
        `SELECT ul.id, ul.user_id FROM user_languages ul
           JOIN languages l ON l.id = ul.language_id
          ORDER BY ul.user_id ASC, l.display_order ASC, l.name ASC`);
      let lastUser = null;
      let pos = 0;
      for (const row of rows) {
        pos = row.user_id === lastUser ? pos + 1 : 0;
        lastUser = row.user_id;
        if (pos) await qi.sequelize.query('UPDATE user_languages SET position = ? WHERE id = ?', { replacements: [pos, row.id] });
      }
    }

    const [existing] = await qi.sequelize.query('SELECT id FROM app_settings WHERE `key` = ?', { replacements: [SETTING_KEY] });
    if (!existing.length) {
      const [sizes] = await qi.sequelize.query(
        'SELECT slug FROM template_sizes WHERE width = 1080 AND height = 1350 AND slug IS NOT NULL ORDER BY id ASC LIMIT 1');
      await qi.bulkInsert('app_settings', [{
        key:         SETTING_KEY,
        value:       sizes.length ? sizes[0].slug : '',
        type:        'string',
        group:       'templates',
        is_public:   1,
        description: 'Slug of the default template size (e.g. 1080×1350). Feed cards prefer this size, and a template family can only be published once it has an English version (or a text-free one) in it.',
      }]);
    }
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('app_settings', { key: SETTING_KEY }, {});
    await queryInterface.removeColumn('user_languages', 'position');
  },
};
