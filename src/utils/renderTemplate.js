// `{{token}}` substitution for notification copy.
//
// One regex, no parser, no dependency. Deliberately NOT a template language:
// there are no filters, expressions, conditionals or loops. This copy is authored
// by admins in a textarea, so any expression syntax would be a stored-injection
// surface and a permanent support burden ("why doesn't {{#if}} work?") in exchange
// for nothing a 43-template catalogue needs.
//
// Formatting is by naming CONVENTION rather than filter syntax — `credits_count`
// formats as a number, `renews_at` as a date. That needs no parser and makes the
// `variables` array on the template self-documenting.

const { ValidationError } = require('../errors');

const TOKEN = /\{\{\s*([a-z0-9_]{1,40})\s*\}\}/g;

// Clamped to the column widths in user_notifications. Done HERE rather than
// trusting the insert, because batch sends go through bulkCreate with
// ignoreDuplicates — which emits INSERT IGNORE, and INSERT IGNORE downgrades
// truncation to a warning and silently stores a chopped string.
const TITLE_MAX = 200;
const BODY_MAX  = 2000;

// Control characters have no business in notification copy and survive a round
// trip through JSON, so a stray one from a pasted value would render as a box in
// the app.
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

const IST = { timeZone: 'Asia/Kolkata' };

// Suffix-driven formatters. The suffix is part of the variable's declared name, so
// the contract is visible in `variables` without anyone learning a filter syntax.
function format(name, value) {
  if (value instanceof Date || /_(at|date)$/.test(name)) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return clean(value);
    return d.toLocaleDateString('en-IN', { ...IST, day: 'numeric', month: 'short', year: 'numeric' });
  }
  if (/_(count|qty)$/.test(name) && Number.isFinite(Number(value))) {
    // en-IN grouping — 12,34,567, not 1,234,567.
    return Number(value).toLocaleString('en-IN');
  }
  if (/_(price|amount)$/.test(name) && Number.isFinite(Number(value))) {
    return `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return clean(value);
}

// Every distinct token in a string, in declaration order.
function tokensIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(TOKEN)) out.add(m[1]);
  return [...out];
}

/**
 * Renders one template string.
 *
 * A token with no value and no default ABORTS rather than degrading. Shipping
 * "Only  AI credits remaining" — or worse, the literal "{{credits_count}}" — is
 * materially worse than sending nothing at all, and it is the kind of bug that
 * ends up in a screenshot. The caller skips that one user and logs; a batch is
 * never failed as a whole.
 */
function renderString(text, values = {}, defaults = {}) {
  const missing = [];
  const used    = {};

  const out = String(text || '').replace(TOKEN, (_, name) => {
    let v = values[name];
    if (v === undefined || v === null || v === '') v = defaults?.[name];
    if (v === undefined || v === null || v === '') { missing.push(name); return ''; }
    const formatted = format(name, v);
    used[name] = formatted;
    return formatted;
  });

  return { text: out, missing, used };
}

/**
 * Renders a template's title + body into the snapshot that lands on the inbox row.
 * Throws ValidationError naming every missing variable at once — a partial render
 * is never returned.
 */
function render(template, values = {}) {
  const defaults = template.variable_defaults || {};

  const t = renderString(template.title, values, defaults);
  const b = renderString(template.body,  values, defaults);

  const missing = [...new Set([...t.missing, ...b.missing])];
  if (missing.length) {
    throw new ValidationError(
      `Notification '${template.code}' is missing values for: ${missing.join(', ')}`,
    );
  }

  return {
    title: t.text.slice(0, TITLE_MAX),
    body:  b.text.slice(0, BODY_MAX),
    // What was actually substituted, for "what exactly did we tell them" and for a
    // future re-render pass.
    variables: { ...t.used, ...b.used },
  };
}

/**
 * A strict, BIDIRECTIONAL check that copy and its declared variables agree.
 *
 * This is a SEED-INTEGRITY check, not the admin write gate. It is what guarantees
 * the 43 seeded templates were authored consistently — every declared variable
 * used, every used variable declared — and the test suite runs it over the whole
 * catalogue.
 *
 * It is deliberately NOT what the admin panel enforces. Requiring an admin to keep
 * a variable list in sync with the wording put the burden in the wrong place: the
 * set of values a trigger can supply is decided by the code that dispatches the
 * notification, not by whoever is fixing a typo. The admin path instead treats
 * `variables` as a server-owned supply list and only rejects placeholders that
 * cannot be filled — see services/notificationTemplateGate.js.
 */
function assertVariableContract({ title, body, variables }) {
  const declared = new Set(Array.isArray(variables) ? variables : []);
  const found    = new Set([...tokensIn(title), ...tokensIn(body)]);

  const undeclared = [...found].filter((t) => !declared.has(t));
  if (undeclared.length) {
    throw new ValidationError(
      `Copy uses undeclared variable(s): ${undeclared.join(', ')}. Add them to 'variables', or remove them from the text.`,
    );
  }

  const unused = [...declared].filter((t) => !found.has(t));
  if (unused.length) {
    throw new ValidationError(
      `Declared variable(s) never used in the copy: ${unused.join(', ')}.`,
    );
  }
}

module.exports = { render, renderString, tokensIn, assertVariableContract, TITLE_MAX, BODY_MAX };
