const Joi = require('joi');

// Admin bodies for the AI catalogue. Cross-field and cross-table rules (adapter
// exists, price_rules match input_schema, the ledger source is an AI one) live in
// services/aiAdmin.service.js as adminCrud beforeWrite gates.

const providerFields = {
  name:              Joi.string().trim().max(100),
  status:            Joi.string().valid('active', 'disabled'),
  base_url:          Joi.string().uri({ scheme: ['https'] }).max(255).allow(null, ''),
  credential_source: Joi.string().valid('db', 'env'),
  rate_limit_rpm:    Joi.number().integer().min(1).max(100000),
  max_concurrency:   Joi.number().integer().min(1).max(1000),
  timeout_ms:        Joi.number().integer().min(1000).max(600000),
  cost_unit:         Joi.string().trim().max(20),
  settings:          Joi.object().allow(null),
  terms_url:         Joi.string().uri().max(500).allow(null, ''),
  notes:             Joi.string().allow(null, ''),
};

// `cost_per_unit_inr` is deliberately absent from both: it is derived from the
// recorded purchases, never typed in.
const createProviderSchema = Joi.object({
  key: Joi.string().trim().pattern(/^[a-z][a-z0-9_]{1,39}$/).required(),
  ...providerFields,
  name: providerFields.name.required(),
});
const updateProviderSchema = Joi.object(providerFields).min(1);

const createCredentialSchema = Joi.object({
  kind:  Joi.string().valid('api_key', 'webhook_secret').required(),
  value: Joi.string().min(8).max(4096).required(),
});

const operationFields = {
  label:           Joi.string().trim().max(100),
  description:     Joi.string().max(500).allow(null, ''),
  credits:         Joi.number().integer().min(0).max(100000),
  unit:            Joi.string().valid('call', 'image', 'text'),
  ledger_source:   Joi.string().max(40),
  input_schema:    Joi.object().allow(null),
  price_rules:     Joi.object().allow(null),
  is_active:       Joi.boolean(),
  // The plans allowed to use it, replacing the whole list. [] = every plan.
  plan_ids:        Joi.array().items(Joi.number().integer().positive()).unique().max(50),
  sort_order:      Joi.number().integer(),
};
const createOperationSchema = Joi.object({
  key: Joi.string().trim().pattern(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/).max(60).required(),
  ...operationFields,
  label: operationFields.label.required(),
  credits: operationFields.credits.required(),
});
// `key` is not updatable: the app calls operations by key.
const updateOperationSchema = Joi.object(operationFields).min(1);

const routeFields = {
  model:            Joi.string().trim().max(100),
  fixed_params:     Joi.object().allow(null),
  provider_units:   Joi.number().min(0).max(1e8),
  priority:         Joi.number().integer().min(0).max(100000),
  weight:           Joi.number().integer().min(0).max(100000),
  fallback_allowed: Joi.boolean(),
  max_cost_inr:     Joi.number().min(0).allow(null),
  is_active:        Joi.boolean(),
};
const createRouteSchema = Joi.object({
  operation_id: Joi.number().integer().required(),
  provider_id:  Joi.number().integer().required(),
  ...routeFields,
  model: routeFields.model.required(),
  provider_units: routeFields.provider_units.required(),
});
// A route is moved to another operation or provider by creating a new one.
const updateRouteSchema = Joi.object(routeFields).min(1);

const createPurchaseSchema = Joi.object({
  provider_id:      Joi.number().integer().required(),
  purchased_at:     Joi.date().iso().required(),
  credits_received: Joi.number().positive().max(1e12).required(),
  amount_paid_inr:  Joi.number().positive().max(1e10).required(),
  amount_foreign:   Joi.number().positive().allow(null),
  currency:         Joi.string().length(3).uppercase().allow(null),
  note:             Joi.string().max(255).allow(null, ''),
});
const updatePurchaseSchema = Joi.object({
  purchased_at:     Joi.date().iso(),
  credits_received: Joi.number().positive().max(1e12),
  amount_paid_inr:  Joi.number().positive().max(1e10),
  amount_foreign:   Joi.number().positive().allow(null),
  currency:         Joi.string().length(3).uppercase().allow(null),
  note:             Joi.string().max(255).allow(null, ''),
}).min(1);

const resolveJobSchema = Joi.object({
  outcome: Joi.string().valid('refund').required(),
  note:    Joi.string().max(255).allow(null, ''),
});

module.exports = {
  createProviderSchema, updateProviderSchema, createCredentialSchema,
  createOperationSchema, updateOperationSchema, createRouteSchema, updateRouteSchema,
  createPurchaseSchema, updatePurchaseSchema, resolveJobSchema,
};
