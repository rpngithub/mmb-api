'use strict';

/**
 * Splits the single `themes.*` permission key into `variants.*` and `brand_series.*`.
 *
 * Before the rename one key governed both the theme groups and the themes inside them.
 * They are now separate admin resources, so a role that could manage themes must end up
 * able to manage BOTH — anything less silently revokes access from existing admins on
 * deploy. Every themes.<action> grant therefore becomes two grants.
 *
 * Kept separate from 000011 (the schema rename) because this rewrites row DATA in a
 * JSON column, and because 000011 may already be applied wherever this lands.
 *
 * `roles.permissions` is a JSON array of "<resource>.<action>" strings, where the action
 * may be the `*` wildcard. The `*` superuser grant is untouched — it already covers both.
 */
const NEW_RESOURCES = ['variants', 'brand_series'];

// themes.read -> [variants.read, brand_series.read]; anything else passes through.
function expand(permissions) {
  const out = [];
  for (const perm of permissions) {
    if (typeof perm !== 'string' || !perm.startsWith('themes.')) {
      out.push(perm);
      continue;
    }
    const action = perm.slice('themes.'.length);
    for (const resource of NEW_RESOURCES) out.push(`${resource}.${action}`);
  }
  return [...new Set(out)];
}

// The reverse: fold variants.<action> back to themes.<action> and drop brand_series.
// Lossy by nature — a role granted only brand_series.read after this migration ran
// collapses to nothing, since there was no such key before the split.
function collapse(permissions) {
  const out = [];
  for (const perm of permissions) {
    if (typeof perm !== 'string') { out.push(perm); continue; }
    if (perm.startsWith('brand_series.')) continue;
    if (perm.startsWith('variants.')) { out.push(`themes.${perm.slice('variants.'.length)}`); continue; }
    out.push(perm);
  }
  return [...new Set(out)];
}

async function rewrite(queryInterface, transform) {
  const [roles] = await queryInterface.sequelize.query('SELECT id, permissions FROM `roles`');
  for (const role of roles) {
    let parsed;
    try {
      // MySQL JSON columns come back parsed; TEXT columns come back as a string.
      parsed = typeof role.permissions === 'string' ? JSON.parse(role.permissions) : role.permissions;
    } catch {
      continue;                       // unparseable — leave the row exactly as it is
    }
    if (!Array.isArray(parsed)) continue;

    const next = transform(parsed);
    if (JSON.stringify(next) === JSON.stringify(parsed)) continue;   // nothing to do

    await queryInterface.sequelize.query(
      'UPDATE `roles` SET permissions = ? WHERE id = ?',
      { replacements: [JSON.stringify(next), role.id] },
    );
  }
}

module.exports = {
  up:   (queryInterface) => rewrite(queryInterface, expand),
  down: (queryInterface) => rewrite(queryInterface, collapse),
};
