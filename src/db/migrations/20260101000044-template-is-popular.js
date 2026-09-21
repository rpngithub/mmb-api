'use strict';

/**
 * Templates gain an editorial `is_popular` flag (0/1), set by admins and
 * filterable on both the public browse (`GET /templates?is_popular=1`) and the
 * admin list. It sits beside `is_premium` and is deliberately NOT derived from
 * `trending_score` / the counters — "popular" is a curated badge the content
 * team hands out, while trending is what the numbers say.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('templates', 'is_popular', {
      type: Sequelize.TINYINT, allowNull: false, defaultValue: 0, after: 'is_premium',
    });
    await queryInterface.addIndex('templates', ['is_popular'], { name: 'templates_is_popular' });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('templates', 'templates_is_popular');
    await queryInterface.removeColumn('templates', 'is_popular');
  },
};
