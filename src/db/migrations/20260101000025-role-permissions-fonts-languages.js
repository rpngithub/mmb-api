'use strict';

/**
 * Grants the existing `content_admin` role the permission domains added after it
 * was seeded: `languages.*` and `fonts.*`.
 *
 * The baseline seeder now lists them, but seeders do not re-run — so on every
 * database that already exists, content admins would get a 403 on the Languages
 * and Fonts screens with nothing to explain why. Migrations DO run on boot here,
 * which is why this is a migration rather than a seeder.
 *
 * ADDITIVE, never a replacement: the row is read, missing domains appended, and
 * written back. Anyone who has customised that role's permissions by hand keeps
 * their edits, and running this twice changes nothing.
 *
 * Deliberately NOT granted: `feedback.*`. Feedback carries the submitter's name,
 * phone and email; curating the catalogue needs none of it. That stays with
 * super_admin until there is a role that actually handles support.
 */
const ROLE = 'content_admin';
const ADD  = ['languages.*', 'fonts.*'];

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
