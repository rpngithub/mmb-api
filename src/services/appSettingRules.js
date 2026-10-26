const { ValidationError } = require('../errors');
const {
  EXTENSIONS, KINDS, SCOPES, MAX_MB_CEILING, key: uploadKey,
} = require('../constants/uploadTypes');

// Per-key value rules for app_settings. The table stores every value as text and
// the generic admin CRUD only checks that a `json` value parses, so a knob with a
// real range — one whose bad value would delete data early — declares it here.
// Each rule returns an error message, or null when the value is acceptable.

// A whole number ≥ 1, written plainly: "10", not "0", "-5", "1.5", "1e3" or " 10".
const positiveInteger = (value) =>
  (/^\d+$/.test(String(value)) && Number(value) >= 1 ? null : 'must be a whole number of at least 1');

const sizeMb = (value) =>
  positiveInteger(value) || (Number(value) > MAX_MB_CEILING ? `must be at most ${MAX_MB_CEILING} (5 GB)` : null);

// A JSON array of known MIME types of one kind. "Known" means listed in
// constants/uploadTypes EXTENSIONS: a type the server has no extension or
// signature check for cannot be switched on from the panel.
const typeList = (kind, { allowSvg }) => (value) => {
  let list;
  try { list = JSON.parse(value); } catch { return 'must be a JSON array of MIME types'; }
  if (!Array.isArray(list) || !list.length) return 'must be a non-empty JSON array of MIME types';
  for (const t of list) {
    if (typeof t !== 'string' || !t.startsWith(`${kind}/`)) return `may only list ${kind}/* types (got ${JSON.stringify(t)})`;
    if (!EXTENSIONS[t]) return `lists ${t}, which the server cannot check — supported: ${Object.keys(EXTENSIONS).filter((x) => x.startsWith(`${kind}/`)).join(', ')}`;
    if (t === 'image/svg+xml' && !allowSvg) return 'may not include image/svg+xml — SVG can carry script and user files are served to browsers';
  }
  return null;
};

const uploadRules = Object.fromEntries(SCOPES.flatMap((scope) => [
  [uploadKey.batchTotalMb(scope), positiveInteger],
  ...KINDS.flatMap((kind) => [
    [uploadKey.maxMb(scope, kind), sizeMb],
    [uploadKey.batchMaxFiles(scope, kind), positiveInteger],
    [uploadKey.types(scope, kind), typeList(kind, { allowSvg: scope === 'admin' })],
  ]),
]));

const RULES = {
  // Minutes. 0 or less would purge on the next run with no window for an admin
  // to reactivate; a fraction is meaningless for a 5-minute job.
  account_deletion_grace_minutes: positiveInteger,
  // Upload limits (group `uploads`). 0 would block every upload; the type lists
  // are the allowlist the presign and confirm checks run against.
  ...uploadRules,
};

// adminCrud `beforeWrite` for /admin/app-settings. Checks the row as it WILL be:
// a PATCH that only renames the key onto a ruled one is checked against the
// value already stored.
function assertSettingValue(payload, row) {
  const key   = payload.key   !== undefined ? payload.key   : row && row.key;
  const value = payload.value !== undefined ? payload.value : row && row.value;
  const rule  = RULES[key];
  if (!rule) return;

  const message = rule(value);
  if (message) {
    throw new ValidationError('Validation failed', [{ field: 'value', message: `${key} ${message}` }]);
  }
}

// The same rule on the read side, for a value stored before the rule existed (or
// written straight to the DB): true when `value` passes its key's rule.
const isValidSetting = (key, value) => !RULES[key] || RULES[key](value) === null;

module.exports = { assertSettingValue, isValidSetting };
