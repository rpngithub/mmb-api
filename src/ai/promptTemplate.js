const aiContext = require('./context');

// The one prompt renderer every adapter uses. A route's template is admin data;
// the values come from the request (validated input) and the server's context
// snapshot (ai/context.js). Zero dependencies, on purpose: tiny syntax, no logic.
//
//   {{field}}                 an input field's value (strings as is, others as JSON)
//   {{?field}} … {{/field}}   the text inside only when the field has a value
//   {{^field}} … {{/field}}   the text inside only when it has none
//                             Sections may nest when the names differ, e.g.
//                             {{^tagline}}{{?auto_tagline}}…{{/auto_tagline}}{{/tagline}}
//
// Reserved names (fill from the server, never from the request):
//   {{input_json}}     every input as JSON, uploaded images left out
//   {{brand_context}}  the business / design snapshot as JSON
//   {{language}}       the language to write in, e.g. "Tamil (தமிழ்)"
//   {{industry}}       the business's industry, or empty
//   {{location}}       the request's location, else the business's city, or empty
//
// Values are inserted in ONE pass, so a value containing "{{…}}" is never expanded.
// Only a template's user part is ever rendered: a provider's system instructions
// are sent as the admin wrote them, so user text cannot reach them.

const PLACEHOLDER_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const SECTION_RE = /\{\{([?^])\s*([a-z][a-z0-9_]*)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g;
const SECTION_OPEN_RE = /\{\{[?^]\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const MAX_DEPTH = 5;

// Resolves sections outside-in, one level per pass, until none is left.
function resolveSections(tpl, keep) {
  let out = tpl;
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    const next = out.replace(SECTION_RE, (_, kind, name, body) => (keep(kind, name) ? body : ''));
    if (next === out) break;
    out = next;
  }
  return out;
}
const RESERVED = ['input_json', 'brand_context', 'language', 'industry', 'location'];

const languageLabel = (l) => {
  if (!l || !l.name) return 'English';
  return l.native_name && l.native_name !== l.name ? `${l.name} (${l.native_name})` : l.name;
};

// An image already resolved for sending ({ base64, mime } or a URL ref) is not text.
const isMediaValue = (v) => v && typeof v === 'object' && !Array.isArray(v) && (v.base64 !== undefined || v.url !== undefined);
function textInput(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (isMediaValue(v) || (Array.isArray(v) && v.some(isMediaValue))) continue;
    out[k] = v;
  }
  return out;
}

function valueOf(name, input, context) {
  switch (name) {
    case 'input_json':    return JSON.stringify(textInput(input), null, 2);
    case 'brand_context': return JSON.stringify(aiContext.forPrompt(context), null, 2);
    case 'language':      return languageLabel(context?.language);
    case 'industry':      return context?.business?.industry || '';
    case 'location':      return context?.location || context?.business?.city || '';
    default: {
      const v = textInput(input)[name];
      if (v === undefined || v === null) return '';
      return typeof v === 'string' ? v : JSON.stringify(v);
    }
  }
}

const present = (name, input, context) => {
  if (name === 'input_json' || name === 'language') return true;
  if (name === 'brand_context') return Object.keys(aiContext.forPrompt(context)).length > 0;
  const v = RESERVED.includes(name) ? valueOf(name, input, context) : (input || {})[name];
  if (v === undefined || v === null || v === false || v === '') return false;
  return !(Array.isArray(v) && !v.length);
};

function render(template, input, context = null) {
  const kept = resolveSections(String(template || ''), (kind, name) => {
    const has = present(name, input, context);
    return kind === '?' ? has : !has;
  });
  return kept.replace(PLACEHOLDER_RE, (_, name) => valueOf(name, input, context));
}

// Every name a template refers to, placeholders and sections (nested ones too).
function names(template) {
  const tpl = String(template || '');
  const out = new Set([...tpl.matchAll(PLACEHOLDER_RE)].map((m) => m[1]));
  for (const m of tpl.matchAll(SECTION_OPEN_RE)) out.add(m[1]);
  return [...out];
}

// Admin-side check: a section opened and never closed (or the reverse), or nested
// deeper than MAX_DEPTH, would be sent to the provider as literal braces. Returns
// a message or null.
function checkSyntax(template) {
  // Keep every body (drop only matched tags), so a broken tag nested inside a
  // well-formed section is still found.
  const stripped = resolveSections(String(template || ''), () => true);
  const stray = stripped.match(/\{\{\s*[?^/][^}]*\}\}/);
  return stray ? `template has an unmatched section tag ${stray[0]}` : null;
}

module.exports = { render, names, checkSyntax, languageLabel, textInput, isMediaValue, RESERVED, PLACEHOLDER_RE };
