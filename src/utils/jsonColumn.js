const { DataTypes } = require('sequelize');

// Sequelize 6 + mysql2 hands JSON columns back as raw STRINGS on this stack — for
// LONGTEXT (what `DataTypes.JSON` actually emits here) and for a native MySQL
// `JSON` column alike. Writes are fine: the JSON type stringifies on the way in.
// It is only the read that never gets parsed, so every JSON column silently
// returned '{"a":1}' where the API contract (and every consumer) expected { a: 1 }.
//
// That was not cosmetic. `authorizeAdmin` does `perms.includes('*')`, which on a
// string is a SUBSTRING test: a content_admin whose permissions read
// ["templates.*","categories.*"] contains a `*`, so the wildcard check passed and
// the role was treated as a superuser with access to plans, coupons and admin
// management. Parsing the column restores real array membership.
//
// Fixed with a getter rather than a migration because the column type is not the
// problem — a native JSON column behaves identically here — and this needs no
// data rewrite.
function parseJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;   // legacy/hand-written rows: hand back what is there rather than throw
  }
}

// Usage: `permissions: jsonColumn('permissions', { allowNull: false, defaultValue: [] })`
// The attribute name has to be passed in — a Sequelize getter receives no name.
const jsonColumn = (name, extra = {}) => ({
  type: DataTypes.JSON,
  ...extra,
  get() {
    return parseJson(this.getDataValue(name));
  },
});

module.exports = { jsonColumn, parseJson };
