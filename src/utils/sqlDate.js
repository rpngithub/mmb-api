// Dates in RAW SQL must go through sqlUtc().
//
// Everything else in this app stores and compares time in UTC: Sequelize models
// write UTC (options.timezone '+00:00') and every connection runs with
// time_zone = '+00:00', so NOW() and column defaults are UTC too. But
// sequelize.query REPLACEMENTS are formatted by Sequelize with no timezone at all
// (utils.format hard-codes `timeZone = null`), which means the Node process's
// LOCAL time. On a host set to IST a Date parameter is written 5h30 ahead of the
// UTC values it is compared with — silently, and not at all on a UTC host.
//
//   sequelize.query('… WHERE created_at >= :since', { replacements: { since: sqlUtc(since) } })
//
// Accepts a Date or anything `new Date()` parses; null/undefined pass through.

function sqlUtc(value) {
  if (value === null || value === undefined) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`sqlUtc: not a date: ${value}`);
  // 2026-11-14T10:00:00.000Z -> 2026-11-14 10:00:00.000
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

// For a shared raw-query helper: every Date in a replacements array/object -> sqlUtc.
// Other values (and nested arrays used for IN lists) are left as they are.
function utcReplacements(replacements) {
  if (Array.isArray(replacements)) return replacements.map((v) => (v instanceof Date ? sqlUtc(v) : v));
  if (replacements && typeof replacements === 'object') {
    return Object.fromEntries(Object.entries(replacements).map(([k, v]) => [k, v instanceof Date ? sqlUtc(v) : v]));
  }
  return replacements;
}

module.exports = { sqlUtc, utcReplacements };
