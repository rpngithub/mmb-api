'use strict';

/**
 * Grants `content_admin` the dashboard widgets that are about the catalogue.
 *
 * Dashboard widgets are gated one permission per widget (`dashboard.<key>`, see
 * services/dashboard.service.js), so a role is given exactly the widgets it should
 * see — never `dashboard.*`. super_admin already sees everything through `*`.
 *
 * Deliberately NOT granted: money (revenue, payments, subscriptions, renewals),
 * the signup funnel, feedback and migrations. A content admin curates designs;
 * none of those is that job, and `renewals_due` lists users' phone numbers.
 *
 * Same shape as 20260101000037: the baseline seeder lists these too, but seeders
 * do not re-run, and migrations do run on boot. ADDITIVE and idempotent — read the
 * row, append what is missing, write it back; hand-customised lists keep their edits.
 */
const ROLE = 'content_admin';
const ADD  = [
  'dashboard.user_summary',
  'dashboard.catalog_coverage',
  'dashboard.events_without_templates',
  'dashboard.pending_industries',
  'dashboard.draft_templates',
];

const parse = (value) => {
  try {
    // The column is JSON but this stack hands it back as a string (see
    // utils/jsonColumn.js); raw queries bypass the model getter entirely.
    const list = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(list) ? list : null;
  } catch {
    return null;              // unparseable by hand-editing — leave it alone rather than clobber it
  }
};

async function rolesOf(queryInterface) {
  const [rows] = await queryInterface.sequelize.query(
    'SELECT id, permissions FROM roles WHERE name = :name AND is_system = 1',
    { replacements: { name: ROLE } },
  );
  return rows || [];
}

const write = (queryInterface, id, list) => queryInterface.sequelize.query(
  'UPDATE roles SET permissions = :permissions WHERE id = :id',
  { replacements: { permissions: JSON.stringify(list), id } },
);

module.exports = {
  async up(queryInterface) {
    for (const row of await rolesOf(queryInterface)) {
      const current = parse(row.permissions);
      if (!current) continue;
      const missing = ADD.filter((p) => !current.includes(p));
      if (missing.length) await write(queryInterface, row.id, [...current, ...missing]);
    }
  },

  async down(queryInterface) {
    for (const row of await rolesOf(queryInterface)) {
      const current = parse(row.permissions);
      if (current) await write(queryInterface, row.id, current.filter((p) => !ADD.includes(p)));
    }
  },
};
