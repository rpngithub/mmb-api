const { Op } = require('sequelize');
const AppError     = require('../errors/AppError');
const { ValidationError, ConflictError, NotFoundError } = require('../errors');
const providers    = require('../ai/providers');
const routing      = require('../ai/routing');
const pricing      = require('../ai/pricing');
const inputSchema  = require('../ai/inputSchema');
const operationCheck = require('../ai/operationCheck');
const { sqlUtc } = require('../utils/sqlDate');
const credentialStore = require('../ai/credentialStore');
const secretBox    = require('../utils/secretBox');
const aiHttp       = require('../ai/http');
const { SOURCES }  = require('../constants/quotaSources');
const { INTERNAL, ProviderError } = require('../ai/errors');
const { STATUS, IN_FLIGHT } = require('../ai/queue');
const configSvc    = require('./config.service');

// The admin side of AI: write gates for the catalogue (adminCrud beforeWrite),
// credential management, provider cost derived from purchases, the margin report
// and the health view. Super-admin territory — see routes/adminAi.router.js.

const models = () => require('../models');
const bad = (field, message) => new ValidationError('Validation failed', [{ field, message }]);

// ---------------------------------------------------------------------------
// Write gates
// ---------------------------------------------------------------------------

// Providers. `key` must name a code adapter and can never change (jobs, routes and
// the webhook URL all hang off it). base_url must be a host the adapter declares,
// so an edited URL can never send our key — or user images — anywhere else.
function assertProviderWritable(payload, row) {
  if (row && payload.key !== undefined && payload.key !== row.key) throw bad('key', 'cannot be changed');
  const key = row ? row.key : payload.key;
  if (!row) providers.assertAdapterKey(key);
  delete payload.cost_per_unit_inr;
  delete payload.cost_updated_at;

  const adapter = providers.get(key);
  const baseUrl = payload.base_url !== undefined ? payload.base_url : row?.base_url;
  if (payload.base_url === '') payload.base_url = null;
  if (baseUrl && !adapter) throw bad('key', `provider ${key} has no adapter in this build`);
  if (baseUrl) {
    try { aiHttp.assertAllowedUrl(baseUrl, adapter.allowedHosts); } catch (err) {
      throw bad('base_url', `must be an https URL on ${adapter.allowedHosts.join(', ')}`);
    }
  }
  if (payload.settings !== undefined && payload.settings !== null && (typeof payload.settings !== 'object' || Array.isArray(payload.settings))) {
    throw bad('settings', 'must be an object');
  }
  const st = payload.settings;
  if (st && st.billing !== undefined && !BILLING_MODES.includes(st.billing)) {
    throw bad('settings.billing', `must be one of ${BILLING_MODES.join(', ')}`);
  }
  if (st && st.inr_per_unit !== undefined && st.inr_per_unit !== null) {
    const n = Number(st.inr_per_unit);
    if (!(n > 0 && n < 1e6)) throw bad('settings.inr_per_unit', 'must be a positive number: rupees per provider unit (per US cent for token-billed providers)');
    if (st.billing !== 'postpaid') throw bad('settings.inr_per_unit', 'applies only with settings.billing = postpaid; prepaid cost comes from recorded purchases');
  }
}

// How we pay a provider:
//   prepaid   (default) we buy credits up front; cost per unit = what the purchases
//             cost us; balance is tracked and alerted.
//   postpaid  billed in arrears (Google: monthly, by tokens). No balance to track.
//             Cost per unit = recorded INVOICES (entered as purchases: units billed,
//             rupees paid) once there are any; until then settings.inr_per_unit,
//             an admin-entered rate (incl. forex markup and GST).
const BILLING_MODES = ['prepaid', 'postpaid'];
const isPostpaid = (provider) => provider?.settings?.billing === 'postpaid';

// Operations. The app calls an operation by key, so the key is permanent; the
// ledger source must be an AI-credits one (or the breakdown would lie, and
// quota.consume would throw at the first request); price rules must match the
// input schema they price; and raising num_images may not outgrow a route whose
// model makes fewer images per request.
async function assertOperationWritable(payload, row) {
  if (payload.plan_ids !== undefined) {
    const { Plan } = models();
    const ids = payload.plan_ids;
    const found = ids.length ? await Plan.count({ where: { id: ids } }) : 0;
    if (found !== ids.length) throw bad('plan_ids', 'contains a plan that does not exist');
    // Not a column: written by syncOperationPlans after the row is saved.
    delete payload.plan_ids;
  }
  assertOperationShape(payload, row);
  if (!row || payload.input_schema === undefined) return;

  const { AiOperationRoute, AiProvider } = models();
  const wants = maxImagesOf(payload.input_schema);
  const routes = await AiOperationRoute.findAll({
    where: { operation_id: row.id, is_active: true },
    include: [{ model: AiProvider, as: 'provider', attributes: ['key'] }],
  });
  const problems = [];
  for (const r of routes) {
    const adapter = providers.get(r.provider?.key);
    const cap = adapter?.maxImagesFor?.(r.model);
    if (cap !== null && cap !== undefined && wants > cap) {
      throw bad('input_schema', `num_images up to ${wants} is more than route ${r.uid} (${r.model}) can make per request (${cap})`);
    }
    // The schema must fit EVERY active route's adapter.
    problems.push(...operationCheck.checkRoute(adapter, { model: r.model, fixedParams: r.fixed_params, uid: r.uid }, payload.input_schema));
  }
  if (problems.length) throw schemaMismatch('input_schema', problems);
}

const schemaMismatch = (field, problems) => new ValidationError('Validation failed', problems.map((message) => ({ field, message })));

function assertOperationShape(payload, row) {
  if (row && payload.key !== undefined && payload.key !== row.key) {
    throw bad('key', 'cannot be changed — the app calls operations by key. Deactivate this one and create a new one.');
  }
  const merged = { ...(row ? row.toJSON() : {}), ...payload };

  const source = merged.ledger_source || 'image_generation';
  if (!SOURCES[source] || SOURCES[source].feature !== 'ai_credits') {
    const allowed = Object.entries(SOURCES).filter(([, s]) => s.feature === 'ai_credits').map(([k]) => k);
    throw bad('ledger_source', `must be one of: ${allowed.join(', ')}`);
  }
  const schemaError = inputSchema.checkDefinition(merged.input_schema);
  if (schemaError) throw bad('input_schema', schemaError);
  const rulesError = pricing.checkRules(merged.price_rules, merged.input_schema);
  if (rulesError) throw bad('price_rules', rulesError);
}

// The provider adapters this build has — what a provider's `key` may be, so the
// admin Key field can be a dropdown instead of free text that 400s. `in_use` =
// an ai_providers row already has that key (keys are unique: pick it to edit,
// not to create). `models` lists the model ids a route may use when the adapter
// has a fixed set (Magnific); null = free text, checked on save (Google: any
// gemini-* id). The fake adapter appears only where it is allowed (not prod).
async function listAdapters() {
  const { AiProvider } = models();
  const rows = await AiProvider.findAll({ attributes: ['uid', 'key', 'status'] });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return providers.keys().map((key) => {
    const a = providers.get(key);
    const row = byKey.get(key);
    return {
      key,
      requires_api_key: Boolean(a.requiresApiKey),
      allowed_hosts: a.allowedHosts || [],
      models: a.MODELS ? Object.keys(a.MODELS) : null,
      in_use: Boolean(row),
      provider: row ? { uid: row.uid, status: row.status } : null,
    };
  });
}

// The plans allowed to use an operation, replaced as a whole. [] = every plan.
// Called after the operation row is saved (adminCrud afterWrite).
async function syncOperationPlans(operationId, planIds) {
  if (!Array.isArray(planIds)) return;
  const { AiOperationPlan, sequelize } = models();
  await sequelize.transaction(async (transaction) => {
    await AiOperationPlan.destroy({ where: { operation_id: operationId }, transaction });
    if (planIds.length) {
      await AiOperationPlan.bulkCreate(planIds.map((plan_id) => ({ operation_id: operationId, plan_id })), { transaction });
    }
  });
}

// Routes. The adapter checks the model and its fixed params.
async function assertRouteWritable(payload, row) {
  const { AiOperation, AiProvider } = models();
  const merged = { ...(row ? row.toJSON() : {}), ...payload };
  if (row && payload.operation_id !== undefined && payload.operation_id !== row.operation_id) throw bad('operation_id', 'cannot be changed');
  if (row && payload.provider_id !== undefined && payload.provider_id !== row.provider_id) throw bad('provider_id', 'cannot be changed');

  const operation = await AiOperation.findByPk(merged.operation_id);
  if (!operation) throw bad('operation_id', 'no such operation');
  const provider = await AiProvider.findByPk(merged.provider_id);
  if (!provider) throw bad('provider_id', 'no such provider');
  const adapter = providers.get(provider.key);
  if (!adapter) throw bad('provider_id', `provider ${provider.key} has no adapter in this build`);

  if (merged.fixed_params !== undefined && merged.fixed_params !== null && (typeof merged.fixed_params !== 'object' || Array.isArray(merged.fixed_params))) {
    throw bad('fixed_params', 'must be an object');
  }
  const err = adapter.validateRoute({ model: merged.model, fixedParams: merged.fixed_params || {} });
  if (err) throw bad('model', err);

  const cap = adapter.maxImagesFor ? adapter.maxImagesFor(merged.model) : null;
  const wants = maxImagesOf(operation.input_schema);
  if (cap !== null && wants > cap) {
    throw bad('model', `${merged.model} makes at most ${cap} image(s) per request, but this operation allows num_images up to ${wants}`);
  }

  // An inactive route is not checked until it is switched on.
  if (merged.is_active !== false && merged.is_active !== 0) {
    const problems = operationCheck.checkRoute(adapter, { model: merged.model, fixedParams: merged.fixed_params, uid: row?.uid }, operation.input_schema);
    if (problems.length) throw schemaMismatch('fixed_params', problems);
  }
}

// The most images one request to an operation can ask for.
const maxImagesOf = (schema) => {
  const f = schema?.fields?.num_images;
  return f ? Number(f.max ?? 1) : 1;
};

// Rows that jobs point at are deactivated, never deleted: ai_jobs keeps their ids
// (without an FK, so job history survives) and the margin report joins on them.
async function assertProviderDeletable(provider) {
  const { AiJob, AiOperationRoute, AiProviderCredential } = models();
  const [jobs, routes, creds] = await Promise.all([
    AiJob.count({ where: { provider_id: provider.id } }),
    AiOperationRoute.count({ where: { provider_id: provider.id } }),
    AiProviderCredential.count({ where: { provider_id: provider.id } }),
  ]);
  if (jobs || routes || creds) {
    throw new ConflictError('This provider has jobs, routes or credentials — set status to disabled instead of deleting it');
  }
}

async function assertRouteDeletable(route) {
  const { AiJob } = models();
  if (await AiJob.count({ where: { route_id: route.id } })) {
    throw new ConflictError('Jobs have used this route — set is_active to false instead of deleting it');
  }
}

async function assertOperationDeletable(op) {
  const { AiJob, AiOperationRoute } = models();
  if (await AiJob.count({ where: { operation_id: op.id } }) || await AiOperationRoute.count({ where: { operation_id: op.id } })) {
    throw new ConflictError('This operation has jobs or routes — set is_active to false instead of deleting it');
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const CREDENTIAL_ATTRS = ['uid', 'kind', 'status', 'last4', 'master_key_version', 'created_by', 'activated_at', 'retired_at', 'created_at'];

async function providerByUid(uid) {
  const { AiProvider } = models();
  const p = await AiProvider.findOne({ where: { uid } });
  if (!p) throw new NotFoundError('provider not found');
  return p;
}

async function credentialFor(provider, credUid) {
  const { AiProviderCredential } = models();
  const row = await AiProviderCredential.findOne({ where: { uid: credUid, provider_id: provider.id } });
  if (!row) throw new NotFoundError('credential not found');
  return row;
}

const publicCredential = (row) => Object.fromEntries(CREDENTIAL_ATTRS.map((k) => [k, row[k] ?? null]));

async function listCredentials(providerUid) {
  const { AiProviderCredential } = models();
  const provider = await providerByUid(providerUid);
  const rows = await AiProviderCredential.findAll({ where: { provider_id: provider.id }, order: [['id', 'DESC']] });
  return rows.map(publicCredential);
}

async function addCredential(providerUid, { kind, value }, adminId) {
  const provider = await providerByUid(providerUid);
  if (!secretBox.isConfigured()) {
    throw new AppError('AI_SECRETS_MASTER_KEY is not configured on this server — credentials cannot be stored', 409, 'AI_MASTER_KEY_MISSING');
  }
  const row = await credentialStore.addPending(provider, kind, value.trim(), { createdBy: adminId });
  return publicCredential(row);
}

// The adapter's cheapest authenticated call, with this credential — so a key can
// be proved BEFORE it goes live. Webhook secrets cannot be tested from our side.
async function verifyCredential(providerUid, credUid) {
  const provider = await providerByUid(providerUid);
  const row = await credentialFor(provider, credUid);
  if (row.status === 'retired') throw new ConflictError('A retired credential cannot be verified');
  if (row.kind !== 'api_key') return { ok: true, verified: false, reason: 'webhook secrets are verified by the next signed webhook' };

  const adapter = providers.get(provider.key);
  if (!adapter) throw new ConflictError(`provider ${provider.key} has no adapter in this build`);
  try {
    await adapter.verifyCredential({ provider, apiKey: await credentialStore.reveal(row.id) });
    return { ok: true, verified: true };
  } catch (raw) {
    const err = raw instanceof ProviderError ? raw : adapter.normalizeError(raw);
    // The provider's verdict, never the key.
    return { ok: false, verified: true, code: err.code, detail: err.detail };
  }
}

async function activateCredential(providerUid, credUid) {
  const provider = await providerByUid(providerUid);
  const row = await credentialFor(provider, credUid);
  if (row.status !== 'pending') throw new ConflictError(`Only a pending credential can be activated (this one is ${row.status})`);
  await credentialStore.activate(row.id);
  return publicCredential(await credentialFor(provider, credUid));
}

async function retireCredential(providerUid, credUid) {
  const provider = await providerByUid(providerUid);
  const row = await credentialFor(provider, credUid);
  if (row.status === 'retired') throw new ConflictError('Already retired');
  await credentialStore.retire(row.id);
  return publicCredential(await credentialFor(provider, credUid));
}

// ---------------------------------------------------------------------------
// Provider cost, derived from purchases
// ---------------------------------------------------------------------------

// Rupees per provider unit = Σ amount paid / Σ credits received over the
// purchases made in the last 12 months — what we are paying for the credits we
// are spending now. A weighted average rather than first-bought-first-used:
// simpler, and exact for the usual single annual prepay. If nothing was bought in
// the last year, the most recent purchase stands.
//
// Jobs snapshot the cost when they are sent, so recomputing it never rewrites
// past margins.
//
// A POSTPAID provider (see BILLING_MODES) uses the same arithmetic over its
// recorded invoices; with none recorded yet, its admin-entered
// settings.inr_per_unit — so a pay-later provider is costed from day one and
// max_cost_inr and the margin report work for it.
const COST_WINDOW_MONTHS = 12;

async function recomputeProviderCost(providerId, now = new Date()) {
  const { AiProvider, ProviderCreditPurchase } = models();
  const since = new Date(now);
  since.setMonth(since.getMonth() - COST_WINDOW_MONTHS);

  let rows = await ProviderCreditPurchase.findAll({ where: { provider_id: providerId, purchased_at: { [Op.gte]: since } } });
  if (!rows.length) {
    rows = await ProviderCreditPurchase.findAll({ where: { provider_id: providerId }, order: [['purchased_at', 'DESC']], limit: 1 });
  }
  const paid    = rows.reduce((s, r) => s + Number(r.amount_paid_inr), 0);
  const credits = rows.reduce((s, r) => s + Number(r.credits_received), 0);
  let cost = credits > 0 ? Math.round((paid / credits) * 1e6) / 1e6 : null;

  if (cost === null) {
    const provider = await AiProvider.findByPk(providerId, { attributes: ['id', 'settings'] });
    const manual = Number(provider?.settings?.inr_per_unit);
    if (isPostpaid(provider) && manual > 0) cost = Math.round(manual * 1e6) / 1e6;
  }

  await AiProvider.update({ cost_per_unit_inr: cost, cost_updated_at: now }, { where: { id: providerId } });
  return cost;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async function listJobs(q = {}) {
  const { AiJob, User } = models();
  const where = {};
  if (q.status) where.status = String(q.status).split(',').map((s) => s.trim()).filter(Boolean);
  for (const f of ['operation_key', 'provider_id', 'user_id', 'error_code']) if (q[f]) where[f] = q[f];
  if (q.from || q.to) {
    where.created_at = {};
    if (q.from) where.created_at[Op.gte] = new Date(q.from);
    if (q.to)   where.created_at[Op.lte] = new Date(q.to);
  }
  const { rows, count } = await AiJob.findAndCountAll({
    where,
    attributes: { exclude: ['provider_result'] },
    include: [{ model: User, attributes: ['uid', 'name', 'phone'] }],
    order: [['id', 'DESC']],
    limit: Math.min(parseInt(q.limit, 10) || 50, 200),
    offset: Math.max(parseInt(q.offset, 10) || 0, 0),
  });
  return { rows, count };
}

async function getJob(uid) {
  const { AiJob, AiJobAttempt, User } = models();
  const job = await AiJob.findOne({
    where: { uid },
    attributes: { exclude: ['provider_result'] },
    include: [
      { model: User, attributes: ['uid', 'name', 'phone'] },
      { model: AiJobAttempt, as: 'attempts', separate: true, order: [['attempt_no', 'ASC']] },
    ],
  });
  if (!job) throw new NotFoundError('AI job not found');
  return job;
}

// Closes a job the system could not settle on its own (stuck `unknown`, a
// processing job whose provider went silent) and refunds the user, exactly once.
async function resolveJob(uid, { note } = {}) {
  const aiJobs = require('./aiJob.service');
  const { AiJob } = models();
  const job = await AiJob.findOne({ where: { uid } });
  if (!job) throw new NotFoundError('AI job not found');
  if (!IN_FLIGHT.includes(job.status)) throw new ConflictError(`Job is already ${job.status}`);
  const done = await aiJobs.failJob(job, INTERNAL.ADMIN_RESOLVED, { from: IN_FLIGHT, detail: note || 'resolved by admin' });
  if (!done) throw new ConflictError('The job changed state while resolving — reload it');
  return getJob(uid);
}

// ---------------------------------------------------------------------------
// Margin report
// ---------------------------------------------------------------------------

const round2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
const marginPct = (revenue, cost) => (revenue > 0 ? round2(((revenue - cost) / revenue) * 100) : null);

async function marginSettings() {
  const s = await configSvc.getSettings({ ai_credit_value_inr: '', ai_target_margin_pct: 50, ai_fx_buffer_pct: 15 });
  const v = parseFloat(s.ai_credit_value_inr);
  return {
    creditValueInr: Number.isFinite(v) && v > 0 ? v : null,
    targetMarginPct: Number(s.ai_target_margin_pct),
    fxBufferPct: Number(s.ai_fx_buffer_pct),
  };
}

/**
 * Actuals per operation and route for jobs created in [from, to), plus a
 * projection per active route at today's cost with the rupee stressed by
 * ai_fx_buffer_pct.
 *
 *   revenue  = credits charged on DONE jobs × ai_credit_value_inr (refunded jobs earned nothing)
 *   cost     = Σ provider units × the cost per unit snapshotted on each done job
 *   at_risk  = the same for FAILED jobs that reached the provider — we may have been
 *              billed for them (open question with Magnific); settle it against the invoice
 */
async function marginReport({ from, to } = {}) {
  const { sequelize, AiOperationRoute, AiOperation, AiProvider } = models();
  const end   = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 864e5);
  const s = await marginSettings();

  // Every non-aggregated column is in GROUP BY (MySQL 8's ONLY_FULL_GROUP_BY).
  const [rows] = await sequelize.query(
    `SELECT operation_key, route_id, provider_id, model, status,
            COUNT(*) AS jobs,
            COALESCE(SUM(credits_charged), 0) AS credits,
            COALESCE(SUM(COALESCE(provider_units_actual, provider_units) * cost_per_unit_inr), 0) AS cost_inr,
            SUM(CASE WHEN cost_per_unit_inr IS NULL THEN 1 ELSE 0 END) AS uncosted
       FROM ai_jobs
      WHERE created_at >= ? AND created_at < ? AND status IN ('done', 'failed') AND route_id IS NOT NULL
      GROUP BY operation_key, route_id, provider_id, model, status`,
    { replacements: [sqlUtc(start), sqlUtc(end)] },
  );

  const providersById = new Map((await AiProvider.findAll({ attributes: ['id', 'key', 'name'] })).map((p) => [p.id, p]));
  const byRoute = new Map();
  for (const r of rows) {
    const k = `${r.operation_key}|${r.route_id}`;
    if (!byRoute.has(k)) {
      const p = providersById.get(Number(r.provider_id));
      byRoute.set(k, {
        operation_key: r.operation_key, route_id: Number(r.route_id),
        provider_key: p?.key || null, model: r.model,
        jobs_done: 0, jobs_failed: 0, credits_sold: 0, cost_inr: 0, at_risk_inr: 0, uncosted_jobs: 0,
      });
    }
    const e = byRoute.get(k);
    if (r.status === 'done') {
      e.jobs_done += Number(r.jobs);
      e.credits_sold += Number(r.credits);
      e.cost_inr += Number(r.cost_inr);
    } else {
      e.jobs_failed += Number(r.jobs);
      e.at_risk_inr += Number(r.cost_inr);
    }
    e.uncosted_jobs += Number(r.uncosted);
  }

  const actuals = [...byRoute.values()].map((e) => {
    const revenue = s.creditValueInr === null ? null : e.credits_sold * s.creditValueInr;
    const margin  = revenue === null ? null : marginPct(revenue, e.cost_inr);
    return {
      ...e,
      cost_inr: round2(e.cost_inr), at_risk_inr: round2(e.at_risk_inr),
      revenue_inr: round2(revenue), margin_pct: margin,
      below_target: margin !== null && margin < s.targetMarginPct,
    };
  });

  const routes = await AiOperationRoute.findAll({
    where: { is_active: true },
    include: [{ model: AiOperation, as: 'operation' }, { model: AiProvider, as: 'provider' }],
    order: [['operation_id', 'ASC'], ['priority', 'ASC']],
  });
  const projection = routes.map((rt) => {
    const cpu = rt.provider.cost_per_unit_inr === null ? null : Number(rt.provider.cost_per_unit_inr);
    const costToday = cpu === null ? null : Number(rt.provider_units) * cpu;
    const stressed  = costToday === null ? null : costToday * (1 + s.fxBufferPct / 100);
    const price     = s.creditValueInr === null ? null : Number(rt.operation.credits) * s.creditValueInr;
    const margin    = price === null || stressed === null ? null : marginPct(price, stressed);
    return {
      operation_key: rt.operation.key, route_id: rt.id, route_uid: rt.uid,
      provider_key: rt.provider.key, model: rt.model, is_operation_active: Boolean(rt.operation.is_active),
      credits_per_unit: Number(rt.operation.credits), provider_units: Number(rt.provider_units),
      price_inr: round2(price), cost_today_inr: round2(costToday), cost_stressed_inr: round2(stressed),
      margin_pct_stressed: margin,
      below_target: margin !== null && margin < s.targetMarginPct,
      cost_unknown: cpu === null,
      postpaid: isPostpaid(rt.provider),
    };
  });

  return {
    period: { from: start, to: end },
    settings: { credit_value_inr: s.creditValueInr, target_margin_pct: s.targetMarginPct, fx_buffer_pct: s.fxBufferPct },
    warnings: [
      ...(s.creditValueInr === null ? ['ai_credit_value_inr is not set — revenue and margins cannot be computed'] : []),
      ...projection.filter((p) => p.cost_unknown).map((p) => (p.postpaid
        ? `${p.provider_key} is postpaid with no invoice recorded and no settings.inr_per_unit — cost unknown for ${p.operation_key}`
        : `${p.provider_key} has no recorded credit purchase — cost unknown for ${p.operation_key}`)),
    ],
    actuals,
    projection,
  };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

async function health() {
  const { AiProvider, AiProviderCredential, AiJob, sequelize } = models();
  const worker = require('../jobs/aiWorker.job');
  const list = await AiProvider.findAll({ order: [['id', 'ASC']] });
  const balanceByProvider = new Map((await require('../ai/balance').balances()).map((b) => [b.provider_id, b]));

  const out = [];
  for (const p of list) {
    const creds = await AiProviderCredential.findAll({ where: { provider_id: p.id, status: 'active' }, attributes: ['kind'] });
    const b = balanceByProvider.get(p.id);
    out.push({
      uid: p.uid, key: p.key, name: p.name, status: p.status, credential_source: p.credential_source,
      unavailable_reason: await routing.unavailableReason(p),
      // closed | open | half_open — this instance's view (the dispatcher's, if it leads).
      circuit: routing.circuitState(p.id),
      active_api_key: creds.some((c) => c.kind === 'api_key'),
      active_webhook_secret: creds.some((c) => c.kind === 'webhook_secret'),
      cost_per_unit_inr: p.cost_per_unit_inr === null ? null : Number(p.cost_per_unit_inr),
      cost_unit: p.cost_unit,
      billing: isPostpaid(p) ? 'postpaid' : 'prepaid',
      // Estimated from our purchases and jobs; null when no purchase is recorded.
      balance: b ? {
        remaining_units: Math.round(b.remaining_units), bought_units: b.bought_units,
        used_units: Math.round(b.used_units), alert_below_units: b.alert_below_units, low: b.low,
      } : null,
    });
  }

  const [byStatus] = await sequelize.query(
    `SELECT status, COUNT(*) AS n, MIN(created_at) AS oldest FROM ai_jobs
      WHERE status IN (${IN_FLIGHT.map(() => '?').join(',')}) GROUP BY status`,
    { replacements: IN_FLIGHT },
  );
  const queue = Object.fromEntries(IN_FLIGHT.map((st) => [st, 0]));
  let oldestQueued = null;
  for (const r of byStatus) {
    queue[r.status] = Number(r.n);
    if (r.status === STATUS.QUEUED) oldestQueued = r.oldest;
  }

  return {
    master_key_configured: secretBox.isConfigured(),
    worker: {
      // This instance's view only. With several instances the leader may be another
      // one; `last_tick_at` null here does not mean nobody is dispatching.
      enabled: require('../config/ai').workerEnabled(),
      this_instance_is_leader: worker.status.leader,
      last_tick_at: worker.status.lastTickAt,
      last_error: worker.status.lastError,
    },
    queue: {
      ...queue,
      oldest_queued_at: oldestQueued,
      oldest_queued_age_seconds: oldestQueued ? Math.round((Date.now() - new Date(oldestQueued).getTime()) / 1000) : null,
    },
    failed_last_24h: await AiJob.count({ where: { status: STATUS.FAILED, completed_at: { [Op.gte]: new Date(Date.now() - 864e5) } } }),
    providers: out,
  };
}

module.exports = {
  assertProviderWritable, assertOperationWritable, assertRouteWritable, syncOperationPlans, listAdapters,
  assertProviderDeletable, assertRouteDeletable, assertOperationDeletable,
  listCredentials, addCredential, verifyCredential, activateCredential, retireCredential,
  recomputeProviderCost, listJobs, getJob, resolveJob, marginReport, health, CREDENTIAL_ATTRS,
};
