const Joi = require('joi');
const { ValidationError } = require('../errors');

// An AI operation's input schema, in OUR terms — what the app sends, never a
// provider's parameter names (the adapter maps those). Stored as JSON on
// ai_operations.input_schema:
//
//   { "fields": {
//       "prompt":           { "type": "string", "required": true, "min": 3, "max": 2000 },
//       "text":             { "type": "string", "required": true, "max_words": 300 },
//       "aspect_ratio":     { "type": "enum", "values": ["1:1", "9:16"], "default": "1:1" },
//       "num_images":       { "type": "integer", "min": 1, "max": 4, "default": 1 },
//       "transparent":      { "type": "boolean", "default": false },
//       "product_image":    { "type": "media", "required": true },
//       "reference_images": { "type": "media_list", "max": 3 }
//   } }
//
// `media` / `media_list` are upload uids from the user's own library (never URLs:
// a URL from the client would let a user make us fetch — and pay a provider to
// process — anything on the internet). `project` is the uid of one of the user's
// own projects (checked at submit; someone else's is a 404).
//
// ENUM OPTIONS. An enum may list `options` instead of (or as well as) `values`:
//
//   "voice": { "type": "enum", "required": true,
//              "options": [ { "value": "kore", "label": "Kore", "gender": "female", "languages": ["en", "hi"] }, … ],
//              "match": { "gender": "voice_gender", "languages": "language" } }
//
// Each option's `value` is what the app sends; the other keys are metadata the
// app shows (the catalogue returns the schema as is). `match` ties an option
// attribute to another field: the chosen option's attribute must equal that
// field's value, or contain it when the attribute is a list. Above: the voice
// must be of the chosen gender and speak the chosen language.
//
// EXACTLY ONE OF. `"one_of": [["image", "project"]]` next to `fields` means the
// request must carry exactly one field of each group — neither, or both, is a 400.
// Fields in a group are never `required` themselves.
//
// Unknown fields are STRIPPED, not rejected: the price is computed here from the
// schema, so a `credits` field a client sends simply has no effect.
//
// SERVER-SIDE CONTEXT. `"context": ["business", "project"]` next to `fields` asks
// the server to add what it knows — the user's business, the project's design —
// to the request (ai/context.js). The app never sends those details itself.
// `"context_rules": { "need_subject": false, "need_industry": true }` tunes it:
//   need_subject   (default true) refuse a request with no business, no project
//                  and no notes — there is nothing to write about
//   need_industry  (default false) refuse a request whose business has no industry

const TYPES = ['string', 'enum', 'integer', 'boolean', 'media', 'media_list', 'project'];
const CONTEXT_SOURCES = ['business', 'project'];
const CONTEXT_RULES = ['need_subject', 'need_industry'];

// Words as people count them: runs of non-space characters. Tamil and Hindi are
// written with spaces between words too, so this holds for every launch language.
const countWords = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

const enumValues = (def) => {
  if (Array.isArray(def.options) && def.options.length) return def.options.map((o) => o && o.value);
  return def.values || [];
};

function fieldSchema(def) {
  let s;
  switch (def.type) {
    case 'string':
      s = Joi.string().trim();
      if (def.min !== undefined) s = s.min(def.min);
      s = s.max(def.max !== undefined ? def.max : 2000);
      if (def.max_words !== undefined) {
        const maxWords = def.max_words;
        s = s.custom((v, helpers) => (countWords(v) > maxWords ? helpers.message(`must be at most ${maxWords} words`) : v));
      }
      break;
    case 'enum':
      s = Joi.string().valid(...enumValues(def));
      break;
    case 'integer':
      s = Joi.number().integer();
      if (def.min !== undefined) s = s.min(def.min);
      if (def.max !== undefined) s = s.max(def.max);
      break;
    case 'boolean':
      s = Joi.boolean();
      break;
    case 'media':
    case 'project':
      s = Joi.string().guid();
      break;
    case 'media_list':
      s = Joi.array().items(Joi.string().guid()).unique().max(def.max !== undefined ? def.max : 4);
      if (def.min !== undefined) s = s.min(def.min);
      break;
    default:
      throw new Error(`unknown input field type ${def.type}`);
  }
  if (def.default !== undefined) s = s.default(def.default);
  return def.required ? s.required() : s;
}

const groupsOf = (inputSchema) => (Array.isArray(inputSchema?.one_of) ? inputSchema.one_of : []);

function compile(inputSchema) {
  const fields = (inputSchema && inputSchema.fields) || {};
  let s = Joi.object(Object.fromEntries(Object.entries(fields).map(([k, def]) => [k, fieldSchema(def)])));
  for (const group of groupsOf(inputSchema)) s = s.xor(...group);
  return s;
}

// The chosen option's attributes against the fields `match` names. Run after Joi,
// on normalised input. Returns [{ field, message }].
function matchProblems(inputSchema, input) {
  const out = [];
  for (const [k, def] of Object.entries((inputSchema && inputSchema.fields) || {})) {
    if (def.type !== 'enum' || !def.match || input[k] === undefined || !Array.isArray(def.options)) continue;
    const opt = def.options.find((o) => o && o.value === input[k]);
    if (!opt) continue;
    for (const [attr, other] of Object.entries(def.match)) {
      const want = input[other];
      if (want === undefined || want === null) continue;
      const have = opt[attr];
      const ok = Array.isArray(have) ? have.includes(want) : have === want;
      if (!ok) out.push({ field: k, message: `${k} ${input[k]} is not available for ${other} ${want}` });
    }
  }
  return out;
}

// Validates and normalises the client's input (defaults applied, unknown fields
// dropped). Throws the same 400 VALIDATION_ERROR shape as every other endpoint.
function validateInput(inputSchema, input) {
  const { value, error } = compile(inputSchema).validate(input || {}, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new ValidationError('Validation failed', error.details.map((d) => ({
      // An exactly-one-of failure belongs to the whole group, not one field.
      field: d.path.join('.') || (d.context?.peers || []).join('|'),
      message: d.message.replace(/['"]/g, ''),
    })));
  }
  const mismatched = matchProblems(inputSchema, value);
  if (mismatched.length) throw new ValidationError('Validation failed', mismatched);
  return value;
}

// The upload uids an input references, with the field each came from.
function mediaRefs(inputSchema, input) {
  const out = [];
  for (const [k, def] of Object.entries((inputSchema && inputSchema.fields) || {})) {
    if (def.type === 'media' && input[k]) out.push({ field: k, uid: input[k] });
    if (def.type === 'media_list' && Array.isArray(input[k])) input[k].forEach((uid, i) => out.push({ field: `${k}.${i}`, uid }));
  }
  return out;
}

function checkEnum(k, def, fields) {
  if (def.options !== undefined) {
    if (!Array.isArray(def.options) || !def.options.length) return `field "${k}" options must be a non-empty list`;
    const values = def.options.map((o) => o && o.value);
    if (values.some((v) => typeof v !== 'string' || !v)) return `field "${k}": every option needs a string "value"`;
    if (new Set(values).size !== values.length) return `field "${k}": option values must be unique`;
    if (def.values !== undefined) return `field "${k}": give "options" or "values", not both`;
  } else if (!Array.isArray(def.values) || !def.values.length) {
    return `field "${k}" needs a non-empty "values" list (or "options")`;
  }
  if (def.match !== undefined) {
    if (!Array.isArray(def.options)) return `field "${k}": "match" needs "options"`;
    if (!def.match || typeof def.match !== 'object' || Array.isArray(def.match)) return `field "${k}": "match" must map an option attribute to a field`;
    for (const [attr, other] of Object.entries(def.match)) {
      if (!fields[other] || other === k) return `field "${k}": match.${attr} names "${other}", which is not another field`;
      if (def.options.some((o) => o[attr] === undefined)) return `field "${k}": every option needs "${attr}" for match`;
    }
  }
  return null;
}

// Checks an admin-supplied schema definition (Phase 2 beforeWrite). Returns an
// error message or null.
function checkDefinition(inputSchema) {
  if (inputSchema === null || inputSchema === undefined) return null;
  if (typeof inputSchema !== 'object' || typeof inputSchema.fields !== 'object' || Array.isArray(inputSchema.fields)) {
    return 'input_schema must be { "fields": { ... } }';
  }
  const fields = inputSchema.fields;
  for (const [k, def] of Object.entries(fields)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) return `field name "${k}" must be snake_case`;
    if (!def || !TYPES.includes(def.type)) return `field "${k}" type must be one of ${TYPES.join(', ')}`;
    if (def.type === 'enum') {
      const bad = checkEnum(k, def, fields);
      if (bad) return bad;
    }
    if (def.max_words !== undefined && (def.type !== 'string' || !Number.isInteger(def.max_words) || def.max_words < 1)) {
      return `field "${k}": max_words is a positive integer on string fields`;
    }
    try { fieldSchema(def); } catch (err) { return `field "${k}": ${err.message}`; }
  }
  const projects = Object.values(fields).filter((d) => d.type === 'project').length;
  if (projects > 1) return 'at most one field of type "project"';
  if (inputSchema.one_of !== undefined) {
    if (!Array.isArray(inputSchema.one_of)) return '"one_of" must be a list of field groups, e.g. [["image", "project"]]';
    const seen = new Set();
    for (const group of inputSchema.one_of) {
      if (!Array.isArray(group) || group.length < 2) return 'each "one_of" group lists at least two fields';
      for (const f of group) {
        if (!fields[f]) return `"one_of" names "${f}", which is not a field`;
        if (fields[f].required) return `"${f}" is in a "one_of" group, so it cannot be required`;
        if (seen.has(f)) return `"${f}" is in more than one "one_of" group`;
        seen.add(f);
      }
    }
  }
  if (inputSchema.context !== undefined) {
    const c = inputSchema.context;
    if (!Array.isArray(c) || c.some((s) => !CONTEXT_SOURCES.includes(s))) return `"context" must be a list of: ${CONTEXT_SOURCES.join(', ')}`;
    if (c.includes('project') && !projects) return '"context" includes project, so a field of type "project" is needed';
  }
  if (inputSchema.context_rules !== undefined) {
    const r = inputSchema.context_rules;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return '"context_rules" must be an object';
    for (const [k, v] of Object.entries(r)) {
      if (!CONTEXT_RULES.includes(k)) return `"context_rules" may only set: ${CONTEXT_RULES.join(', ')}`;
      if (typeof v !== 'boolean') return `context_rules.${k} must be true or false`;
    }
    if (r.need_industry && !(Array.isArray(inputSchema.context) && inputSchema.context.includes('business'))) {
      return 'context_rules.need_industry needs "business" in "context"';
    }
  }
  return null;
}

// The uid of the one `project` field, if the input has one: { field, uid } | null.
function projectRef(inputSchema, input) {
  for (const [k, def] of Object.entries((inputSchema && inputSchema.fields) || {})) {
    if (def.type === 'project' && input[k]) return { field: k, uid: input[k] };
  }
  return null;
}

module.exports = {
  validateInput, mediaRefs, projectRef, checkDefinition, compile, countWords, enumValues,
  TYPES, CONTEXT_SOURCES, CONTEXT_RULES,
};
