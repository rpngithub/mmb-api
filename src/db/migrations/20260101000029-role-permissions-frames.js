'use strict';

/**
 * Grants `content_admin` the `frames.*` domain added by the frames catalogue
 * (migration 20260101000028).
 *
 * Same reasoning as 20260101000025: the baseline seeder now lists the domain, but
 * seeders do not re-run, so on every database that already exists a content admin
 * would open the new Frames screen and get a 403 with nothing to explain it.
 * Migrations DO run on boot here, which is why this is a migration.
 *
 * ADDITIVE and idempotent: read the row, append what is missing, write it back.
 * Hand-customised permission lists keep their edits.
 */
const ROLE = 'content_admin';
const ADD  = ['frames.*'];

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SELECT id, permissions FROM roles WHERE name = :name AND is_system = 1',
      { replacements: { name: ROLE } },
    );
    if (!rows.length) return;   // custom deployment without the seeded role — nothing to do

    for (const row of rows) {
      let current;
      try {
        // The column is JSON but this stack hands it back as a string (see
        // utils/jsonColumn.js); raw queries bypass the model getter entirely.
        current = typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions;
      } catch {
        continue;               // unparseable by hand-editing — leave it alone rather than clobber it
      }
      if (!Array.isArray(current)) continue;

      const missing = ADD.filter((p) => !current.includes(p));
      if (!missing.length) continue;                     // already granted; idempotent

      await queryInterface.sequelize.query(
        'UPDATE roles SET permissions = :permissions WHERE id = :id',
        { replacements: { permissions: JSON.stringify([...current, ...missing]), id: row.id } },
      );
    }
  },

  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SELECT id, permissions FROM roles WHERE name = :name AND is_system = 1',
      { replacements: { name: ROLE } },
    );
    for (const row of rows || []) {
      let current;
      try {
        current = typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions;
      } catch { continue; }
      if (!Array.isArray(current)) continue;

      await queryInterface.sequelize.query(
        'UPDATE roles SET permissions = :permissions WHERE id = :id',
        { replacements: { permissions: JSON.stringify(current.filter((p) => !ADD.includes(p))), id: row.id } },
      );
    }
  },
};
