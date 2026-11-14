const { ValidationError } = require('../errors');

// What an AI request costs the user, in MMB credits. Always computed here, from
// the operation row and the VALIDATED input — never taken from the client.
//
//   credits_charged = ceil(operation.credits × units × Π multipliers)
//
// ai_operations.price_rules:
//   {
//     "units_from":  "num_images",                       // optional: an integer input field
//     "multipliers": { "quality": { "low": 1, "high": 2 } } // optional: per enum value
//   }
//
// Nothing here knows how many provider credits an MMB credit is worth — that
// ratio is still undecided, and lives entirely in the `credits` an admin sets on
// each operation. Changing the unit is a data change, not a release.

function computeCredits(operation, input) {
  const rules = operation.price_rules || {};
  let units = 1;

  if (rules.units_from) {
    const v = input[rules.units_from];
    units = v === undefined || v === null ? 1 : Number(v);
    if (!Number.isInteger(units) || units < 1) {
      throw new ValidationError('Validation failed', [{ field: rules.units_from, message: 'must be a whole number of at least 1' }]);
    }
  }

  let multiplier = 1;
  for (const [param, table] of Object.entries(rules.multipliers || {})) {
    const v = input[param];
    if (v === undefined || v === null) continue;
    const m = table[String(v)];
    if (m === undefined) {
      throw new ValidationError('Validation failed', [{ field: param, message: `has no price for "${v}"` }]);
    }
    multiplier *= Number(m);
  }

  // The epsilon keeps 1 × 1.1 × 10 (= 11.000000000000002) from rounding up to 12.
  return Math.max(0, Math.ceil(Number(operation.credits) * units * multiplier - 1e-9));
}

// Checks an admin-supplied price_rules definition against the operation's input
// schema (Phase 2 beforeWrite). Returns an error message or null.
function checkRules(priceRules, inputSchema) {
  if (priceRules === null || priceRules === undefined) return null;
  if (typeof priceRules !== 'object' || Array.isArray(priceRules)) return 'price_rules must be an object';
  const fields = (inputSchema && inputSchema.fields) || {};
  if (priceRules.units_from !== undefined) {
    const f = fields[priceRules.units_from];
    if (!f || f.type !== 'integer') return `units_from "${priceRules.units_from}" must name an integer input field`;
  }
  for (const [param, table] of Object.entries(priceRules.multipliers || {})) {
    const f = fields[param];
    if (!f) return `multiplier "${param}" names no input field`;
    if (typeof table !== 'object' || Array.isArray(table)) return `multiplier "${param}" must map values to numbers`;
    for (const [v, m] of Object.entries(table)) {
      if (!(Number(m) > 0)) return `multiplier "${param}.${v}" must be a positive number`;
    }
    if (f.type === 'enum') {
      const missing = (f.values || []).filter((v) => table[v] === undefined);
      if (missing.length) return `multiplier "${param}" has no price for ${missing.join(', ')}`;
    }
  }
  return null;
}

module.exports = { computeCredits, checkRules };
