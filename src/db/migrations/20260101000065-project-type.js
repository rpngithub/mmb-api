'use strict';

/**
 * projects.project_type — whether a design is an image or a video.
 *
 * Until now the only answer was the template's family type, which an admin sets
 * at upload and the editor can never change. That is wrong as soon as a user
 * animates a static design (it becomes a video) or strips the animation out of a
 * video one, and a blank project had no type at all. The editor now sends it on
 * create and on every save that changes it.
 *
 * Two values only: the templates' `animated` is the same product as `video` (it
 * already shared the Video Templates quota), so it maps to `video` here.
 *
 * Existing rows are filled from their template — video/animated families become
 * `video`, everything else (including blank projects) keeps the `image` default.
 *
 * The type also decides which plan meter a template project counts against (see
 * constants/quotaMeters.js), so this must run WITH the code that reads it: the
 * Business Posts / Video gauges count projects by this column.
 *
 * Mirrors src/models/project.model.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // MySQL DDL cannot be rolled back; a run cut off after the ALTER must still
    // be able to finish the backfill on the next boot.
    const columns = await queryInterface.describeTable('projects');
    if (!columns.project_type) {
      await queryInterface.addColumn('projects', 'project_type', {
        type: Sequelize.ENUM('image', 'video'),
        allowNull: false,
        defaultValue: 'image',
        after: 'size_id',
      });
    }

    const [result] = await queryInterface.sequelize.query(`
      UPDATE projects p
        JOIN templates t         ON t.id = p.template_id
        JOIN template_families f ON f.id = t.family_id
         SET p.project_type = 'video'
       WHERE f.template_type IN ('video', 'animated')
         AND p.project_type <> 'video'
    `);
    console.log(`[migration 065] marked ${result.affectedRows ?? 0} project(s) as video from their template`);
  },

  async down(queryInterface) {
    const columns = await queryInterface.describeTable('projects');
    if (columns.project_type) await queryInterface.removeColumn('projects', 'project_type');
  },
};
