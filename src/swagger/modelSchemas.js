// Generates OpenAPI component schemas from the Sequelize models, applying the
// control rules in schemaConfig.js. For every generated schema `X` it also emits
// `XResponse` ({ success, data: X }) and `XListResponse` ({ success, data: [X] })
// so endpoints can document the standard envelope with real field detail.
const sequelize = require('../config/db');
require('../models'); // ensure all models are registered on the instance
const config = require('./schemaConfig');

const GLOBAL_EXCLUDE = config.globalExclude || [];

function mapType(attr) {
  const t   = attr.type || {};
  const key = t.key || (t.constructor && t.constructor.key) || '';
  switch (key) {
    case 'INTEGER': case 'BIGINT': case 'SMALLINT': case 'TINYINT':
      return { type: 'integer' };
    case 'FLOAT': case 'DOUBLE': case 'REAL': case 'DECIMAL':
      return { type: 'number' };
    case 'BOOLEAN':
      return { type: 'boolean' };
    case 'DATE':
      return { type: 'string', format: 'date-time' };
    case 'DATEONLY':
      return { type: 'string', format: 'date' };
    case 'UUID':
      return { type: 'string', format: 'uuid' };
    case 'JSON': case 'JSONB':
      return { type: 'object' };
    case 'ENUM':
      return { type: 'string', enum: t.values || [] };
    default:
      return { type: 'string' };
  }
}

function buildObject(model, opts = {}) {
  const attrs   = model.rawAttributes;
  const exclude = new Set([...GLOBAL_EXCLUDE, ...(opts.exclude || [])]);
  let keys = Object.keys(attrs);
  if (opts.include && opts.include.length) keys = keys.filter((k) => opts.include.includes(k));
  keys = keys.filter((k) => !exclude.has(k));

  const properties = {};
  for (const k of keys) {
    const schema = mapType(attrs[k]);
    if (attrs[k].allowNull !== false && !attrs[k].primaryKey) schema.nullable = true;
    properties[k] = schema;
  }
  for (const [name, def] of Object.entries(opts.add || {})) {
    properties[name] = typeof def === 'string' ? { type: def } : def;
  }
  return { type: 'object', properties };
}

function envelope(name) {
  return {
    [`${name}Response`]: {
      type: 'object',
      properties: { success: { type: 'boolean', example: true }, data: { $ref: `#/components/schemas/${name}` } },
    },
    [`${name}ListResponse`]: {
      type: 'object',
      properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: `#/components/schemas/${name}` } } },
    },
  };
}

function generate() {
  const schemas = {};
  const models  = sequelize.models;

  for (const modelName of Object.keys(models)) {
    const cfg = config[modelName] || {};
    if (cfg.skip) continue;
    if (cfg.views) {
      for (const [viewName, viewOpts] of Object.entries(cfg.views)) {
        schemas[viewName] = buildObject(models[modelName], viewOpts);
      }
    } else {
      schemas[modelName] = buildObject(models[modelName], cfg);
    }
  }

  const envelopes = {};
  for (const name of Object.keys(schemas)) Object.assign(envelopes, envelope(name));

  return {
    ...schemas,
    ...envelopes,
    SuccessResponse: {
      type: 'object',
      properties: { success: { type: 'boolean', example: true }, data: { type: 'object', nullable: true } },
    },
    ErrorResponse: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        error: {
          type: 'object',
          properties: {
            code:    { type: 'string' },
            message: { type: 'string' },
            details: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
  };
}

module.exports = generate();
