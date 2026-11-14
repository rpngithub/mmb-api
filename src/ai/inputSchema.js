const Joi = require('joi');
const { ValidationError } = require('../errors');

// An AI operation's input schema, in OUR terms — what the app sends, never a
// provider's parameter names (the adapter maps those). Stored as JSON on
// ai_operations.input_schema:
//
//   { "fields": {
//       "prompt":           { "type": "string", "required": true, "min": 3, "max": 2000 },
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
// Unknown fields are STRIPPED, not rejected: the price is computed here from the
// schema, so a `credits` field a client sends simply has no effect.
//
// SERVER-SIDE CONTEXT. `"context": ["business", "project"]` next to `fields` asks
// the server to add what it knows — the user's business, the project's design —
// to the request (ai/context.js). The app never sends those details itself.

const TYPES = ['string', 'enum', 'integer', 'boolean', 'media', 'media_list', 'project'];
const CONTEXT_SOURCES = ['business', 'project'];

function fieldSchema(def) {
  let s;
  switch (def.type) {
    case 'string':
      s = Joi.string().trim();
      if (def.min !== undefined) s = s.min(def.min);
      s = s.max(def.max !== undefined ? def.max : 2000);
      break;
    case 'enum':
      s = Joi.string().valid(...(def.values || []));
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

function compile(inputSchema) {
  const fields = (inputSchema && inputSchema.fields) || {};
  return Joi.object(Object.fromEntries(Object.entries(fields).map(([k, def]) => [k, fieldSchema(def)])));
}

// Validates and normalises the client's input (defaults applied, unknown fields
// dropped). Throws the same 400 VALIDATION_ERROR shape as every other endpoint.
function validateInput(inputSchema, input) {
  const { value, error } = compile(inputSchema).validate(input || {}, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new ValidationError('Validation failed', error.details.map((d) => ({
      field: d.path.join('.'), message: d.message.replace(/['"]/g, ''),
    })));
  }
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

// Checks an admin-supplied schema definition (Phase 2 beforeWrite). Returns an
// error message or null.
function checkDefinition(inputSchema) {
  if (inputSchema === null || inputSchema === undefined) return null;
  if (typeof inputSchema !== 'object' || typeof inputSchema.fields !== 'object' || Array.isArray(inputSchema.fields)) {
    return 'input_schema must be { "fields": { ... } }';
  }
  for (const [k, def] of Object.entries(inputSchema.fields)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) return `field name "${k}" must be snake_case`;
    if (!def || !TYPES.includes(def.type)) return `field "${k}" type must be one of ${TYPES.join(', ')}`;
    if (def.type === 'enum' && (!Array.isArray(def.values) || !def.values.length)) return `field "${k}" needs a non-empty "values" list`;
    try { fieldSchema(def); } catch (err) { return `field "${k}": ${err.message}`; }
  }
  const projects = Object.values(inputSchema.fields).filter((d) => d.type === 'project').length;
  if (projects > 1) return 'at most one field of type "project"';
  if (inputSchema.context !== undefined) {
    const c = inputSchema.context;
    if (!Array.isArray(c) || c.some((s) => !CONTEXT_SOURCES.includes(s))) return `"context" must be a list of: ${CONTEXT_SOURCES.join(', ')}`;
    if (c.includes('project') && !projects) return '"context" includes project, so a field of type "project" is needed';
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

module.exports = { validateInput, mediaRefs, projectRef, checkDefinition, compile, TYPES, CONTEXT_SOURCES };
