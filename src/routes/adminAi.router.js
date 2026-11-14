const express        = require('express');
const router         = express.Router();
const authenticate   = require('../middlewares/authenticate');
const authorizeAdmin = require('../middlewares/authorizeAdmin');
const validate       = require('../middlewares/validate');
const requireAdminReauth = require('../middlewares/requireAdminReauth');
const { requireAdminReauthIf } = requireAdminReauth;
const adminCrud      = require('../utils/adminCrud');
const activity       = require('../services/activity.service');
const aiAdmin        = require('../services/aiAdmin.service');
const models         = require('../models');
const v              = require('../validators/aiAdmin.validator');

// /admin/ai — the AI catalogue, provider keys, costs, jobs and reports.
//
// Four permission domains, none of them in content_admin, so only super_admin
// (`*`) holds them out of the box — the same call quota_packs makes. Prices and
// provider keys are commerce and secrets, not content:
//   ai_providers   providers, their credentials, credit purchases
//   ai_operations  the operations users buy, and the routes that fulfil them
//   ai_jobs        the job log, and resolving a stuck job (refund)
//   ai_reports     the margin report and health
//
// Credential writes and provider host changes additionally need the admin's
// password re-typed (X-Admin-Password, middlewares/requireAdminReauth.js).
//
// Custom routes are registered BEFORE each adminCrud mount, so a literal path is
// never swallowed by the CRUD's `/:id`.

const A = (perm) => [authenticate, authorizeAdmin(perm)];
const C = (path, opts) => router.use(path, adminCrud(opts));

// Runs a guard on the row a DELETE targets, then falls through to the CRUD.
const deleteGuard = (model, guard) => async (req, res, next) => {
  const row = await model.findOne({ where: { uid: req.params.id } });
  if (row) await guard(row);
  next();
};

const PROVIDER_BRIEF  = ['id', 'uid', 'key', 'name', 'status'];
const OPERATION_BRIEF = ['id', 'uid', 'key', 'label', 'is_active'];

// ---------------------------------------------------------------------------
// Providers + credentials
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /admin/ai/providers/{uid}/credentials:
 *   get:
 *     summary: A provider's credentials — metadata only, never the value
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: '[{ uid, kind, status (pending|active|retired), last4, master_key_version, activated_at, retired_at, created_at }]' }
 *   post:
 *     summary: Add a key or webhook secret (stored encrypted, as pending)
 *     description: >
 *       Write-only: the value is never returned again; only `last4`. Needs the admin's
 *       password re-typed in `X-Admin-Password` (403 REAUTH_REQUIRED / REAUTH_FAILED,
 *       429 REAUTH_LOCKED after 5 failures in 15 min). Then verify it, then activate it.
 *       409 AI_MASTER_KEY_MISSING when the server has no AI_SECRETS_MASTER_KEY.
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: uid, required: true, schema: { type: string, format: uuid } }
 *       - { in: header, name: X-Admin-Password, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [kind, value], properties: { kind: { type: string, enum: [api_key, webhook_secret] }, value: { type: string, minLength: 8 } } } } }
 *     responses:
 *       201: { description: The pending credential (metadata only) }
 * /admin/ai/providers/{uid}/credentials/{credUid}/verify:
 *   post:
 *     summary: Test a key with the provider's cheapest authenticated call, before activating it
 *     description: >
 *       `{ ok, verified, code?, detail? }`. For Magnific this is a real (possibly billed) call.
 *       Webhook secrets cannot be tested from our side (`verified: false`).
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: uid, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: credUid, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Verification result }
 * /admin/ai/providers/{uid}/credentials/{credUid}/activate:
 *   post:
 *     summary: pending → active; the previously active credential of the same kind → retired
 *     description: >
 *       Takes effect on every instance within a minute (the decrypted-key cache). A retired
 *       webhook secret is still accepted for AI_WEBHOOK_SECRET_OVERLAP_HOURS (default 24).
 *       Needs X-Admin-Password.
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: uid, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: credUid, required: true, schema: { type: string, format: uuid } }
 *       - { in: header, name: X-Admin-Password, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The activated credential }
 *       409: { description: Not pending }
 * /admin/ai/providers/{uid}/credentials/{credUid}/retire:
 *   post:
 *     summary: Retire a credential (a provider left with no active key stops taking jobs)
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: uid, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: credUid, required: true, schema: { type: string, format: uuid } }
 *       - { in: header, name: X-Admin-Password, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The retired credential }
 * /admin/ai/adapters:
 *   get:
 *     summary: Provider adapters this build supports (the values a provider `key` may take)
 *     description: >
 *       For the admin "Key" dropdown on Create Provider. `in_use` = a provider row already
 *       has that key (keys are unique — choose it to edit that row, `provider.uid`).
 *       `allowed_hosts` = what `base_url` may point at. `models` = the model ids a route
 *       may use, or null when the model is free text validated on save (google: any
 *       gemini-* id). `fake` is listed only outside production.
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Adapters
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 - { key: magnific, requires_api_key: true, allowed_hosts: [api.magnific.com, '*.magnific.com', '*.freepik.com'], models: [nano-banana-pro, gpt-image-2, remove-background], in_use: true, provider: { uid: '…', status: disabled } }
 *                 - { key: google, requires_api_key: true, allowed_hosts: [generativelanguage.googleapis.com], models: null, in_use: true, provider: { uid: '…', status: disabled } }
 */
router.get('/adapters', ...A('ai_providers.read'), async (req, res) => {
  res.json({ success: true, data: await aiAdmin.listAdapters() });
});

router.get('/providers/:uid/credentials', ...A('ai_providers.read'), async (req, res) => {
  res.json({ success: true, data: await aiAdmin.listCredentials(req.params.uid) });
});

router.post('/providers/:uid/credentials', ...A('ai_providers.update'), requireAdminReauth, validate(v.createCredentialSchema), async (req, res) => {
  const data = await aiAdmin.addCredential(req.params.uid, req.body, req.user.userId);
  await activity.log(req, { action: 'ai_credential.created', entityType: 'ai_credential', metadata: { provider_uid: req.params.uid, uid: data.uid, kind: data.kind, last4: data.last4 } });
  res.status(201).json({ success: true, data });
});

router.post('/providers/:uid/credentials/:credUid/verify', ...A('ai_providers.update'), async (req, res) => {
  const data = await aiAdmin.verifyCredential(req.params.uid, req.params.credUid);
  await activity.log(req, { action: 'ai_credential.verified', entityType: 'ai_credential', metadata: { uid: req.params.credUid, ok: data.ok, code: data.code || null } });
  res.json({ success: true, data });
});

router.post('/providers/:uid/credentials/:credUid/activate', ...A('ai_providers.update'), requireAdminReauth, async (req, res) => {
  const data = await aiAdmin.activateCredential(req.params.uid, req.params.credUid);
  await activity.log(req, { action: 'ai_credential.activated', entityType: 'ai_credential', metadata: { uid: data.uid, kind: data.kind, last4: data.last4 } });
  res.json({ success: true, data });
});

router.post('/providers/:uid/credentials/:credUid/retire', ...A('ai_providers.update'), requireAdminReauth, async (req, res) => {
  const data = await aiAdmin.retireCredential(req.params.uid, req.params.credUid);
  await activity.log(req, { action: 'ai_credential.retired', entityType: 'ai_credential', metadata: { uid: data.uid, kind: data.kind, last4: data.last4 } });
  res.json({ success: true, data });
});

/**
 * @swagger
 * /admin/ai/providers:
 *   get:
 *     summary: AI providers (standard admin CRUD; GET/PATCH/DELETE /admin/ai/providers/{uid})
 *     description: >
 *       `key` must name a provider adapter in this build (`fake` on dev/test, `magnific`,
 *       `google`) and never changes. `base_url` must be an https URL on a host the
 *       adapter declares. Changing `base_url` or `credential_source` needs X-Admin-Password.
 *       `cost_per_unit_inr` is read-only. Prepaid providers (default): derived from credit
 *       purchases. `settings.billing: postpaid` (billed in arrears, e.g. Google): derived from
 *       recorded invoices (entered as purchases), and until there is one from
 *       `settings.inr_per_unit` (rupees per provider unit incl. forex and GST); no balance is
 *       tracked. Token-billed providers use `cost_unit: usd_cent` — one unit = one US cent —
 *       with per-model token rates in the route's `fixed_params`. A provider with
 *       jobs, routes or credentials cannot be deleted (409); set `status: disabled`.
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Providers }
 */
router.post('/providers', ...A('ai_providers.create'), requireAdminReauthIf(['base_url', 'credential_source']), (req, res, next) => next());
router.patch('/providers/:id', ...A('ai_providers.update'), requireAdminReauthIf(['base_url', 'credential_source']), (req, res, next) => next());
router.delete('/providers/:id', ...A('ai_providers.delete'), deleteGuard(models.AiProvider, aiAdmin.assertProviderDeletable));
C('/providers', {
  model: models.AiProvider, resource: 'ai_provider', permission: 'ai_providers',
  unique: ['key'], filterable: ['status'],
  createSchema: v.createProviderSchema, updateSchema: v.updateProviderSchema,
  beforeWrite: (payload, row) => aiAdmin.assertProviderWritable(payload, row),
  // A postpaid provider's manual rate (settings.inr_per_unit) lands in
  // cost_per_unit_inr at once; only a settings change can move it.
  afterWrite: (row, req, { action }) => (action !== 'deleted' && req.body?.settings !== undefined
    ? aiAdmin.recomputeProviderCost(row.id) : null),
});

// ---------------------------------------------------------------------------
// Credit purchases — what we paid; drives the provider's cost per unit
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /admin/ai/provider-purchases:
 *   get:
 *     summary: Provider credit purchases (standard admin CRUD)
 *     description: >
 *       Record each purchase from the card statement: the rupees actually charged (incl.
 *       forex markup and GST) and the provider credits received. Every create/update/delete
 *       recomputes the provider's `cost_per_unit_inr` = Σ paid ÷ Σ credits over purchases
 *       in the last 12 months (else the latest one). Past jobs keep the cost they were
 *       sent at.
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: provider_id, schema: { type: integer } }]
 *     responses:
 *       200: { description: Purchases }
 */
C('/provider-purchases', {
  model: models.ProviderCreditPurchase, resource: 'ai_provider_purchase', permission: 'ai_providers',
  filterable: ['provider_id'],
  listOptions: { order: [['purchased_at', 'DESC']] },
  include: [{ model: models.AiProvider, as: 'provider', attributes: PROVIDER_BRIEF }],
  createSchema: v.createPurchaseSchema, updateSchema: v.updatePurchaseSchema,
  injectOnCreate: (req) => ({ created_by: req.user.userId }),
  afterWrite: (row) => aiAdmin.recomputeProviderCost(row.provider_id),
});

// ---------------------------------------------------------------------------
// Operations + routes
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /admin/ai/operations:
 *   get:
 *     summary: AI operations — what users buy (standard admin CRUD + PATCH /reorder)
 *     description: >
 *       `key` is what the app calls and never changes. `credits` is the price per unit in
 *       MMB AI credits. `input_schema` `{ fields: { name: { type, required?, min?, max?,
 *       values?, default? } } }` with types string | enum | integer | boolean | media |
 *       media_list. `price_rules` `{ units_from?, multipliers?: { field: { value: n } } }`
 *       must cover every value of an enum it prices. `ledger_source` is the Usage-screen
 *       breakdown row (image_generation, background_removal, image_edit, …). `plan_ids`
 *       (write) replaces the plans allowed to use it — `[]` = every plan, Free and the
 *       access pass included; users on other plans get 403 AI_PLAN_REQUIRED before
 *       anything is charged. Each row includes its routes and `plans`. An operation with
 *       jobs or routes cannot be deleted (409).
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Operations }
 */
router.delete('/operations/:id', ...A('ai_operations.delete'), deleteGuard(models.AiOperation, aiAdmin.assertOperationDeletable));
C('/operations', {
  model: models.AiOperation, resource: 'ai_operation', permission: 'ai_operations',
  unique: ['key'], filterable: ['is_active'],
  reorderable: true, orderColumn: 'sort_order',
  listOptions: { order: [['sort_order', 'ASC'], ['id', 'ASC']] },
  include: [
    {
      model: models.AiOperationRoute, as: 'routes',
      include: [{ model: models.AiProvider, as: 'provider', attributes: PROVIDER_BRIEF }],
    },
    { model: models.Plan, as: 'plans', attributes: ['id', 'uid', 'name', 'plan_type', 'status'], through: { attributes: [] } },
  ],
  createSchema: v.createOperationSchema, updateSchema: v.updateOperationSchema,
  beforeWrite: (payload, row) => aiAdmin.assertOperationWritable(payload, row),
  afterWrite: (row, req, { action }) => (action === 'deleted' ? null : aiAdmin.syncOperationPlans(row.id, req.body?.plan_ids)),
});

/**
 * @swagger
 * /admin/ai/routes:
 *   get:
 *     summary: Routes — who fulfils an operation, at what cost (standard admin CRUD)
 *     description: >
 *       `operation_id` and `provider_id` are set on create and never change. `model` and
 *       `fixed_params` are checked by the provider's adapter, and an ACTIVE route must fit
 *       its operation's input_schema (required fields present, no field the model never
 *       receives, enum values it can take, Google placeholders backed by fields) — else 400
 *       with one `details` entry per problem; the same check runs when the operation's
 *       input_schema is saved, against every active route. `provider_units` is what one
 *       call costs us in the provider's cost_unit (jobs snapshot it); for a token-billed
 *       route it is the ESTIMATED US cents per call (used by `max_cost_inr` and the margin
 *       projection) — the actual cost from token usage is recorded per job.
 *
 *
 *       `google` routes (synchronous text, structured JSON): `model` is a Gemini model id;
 *       `fixed_params` = `system_prompt` (required), `user_template` (`{{field}}`,
 *       `{{input_json}}`), `output_schema` (required, JSON Schema, type object — sent as
 *       responseJsonSchema; maxLength is enforced by us, Google ignores it),
 *       `max_output_tokens` (required), `thinking` (required: Gemini 3+ `{ level:
 *       minimal|low|medium|high }`, Gemini 2.x `{ budget }`), `temperature`,
 *       `input_cents_per_mtok` and `output_cents_per_mtok` (required, US cents per 1M
 *       tokens; gemini-3.5-flash-lite paid tier: 30 and 250), `safety_settings`.
 *
 *
 *       Routing (chosen per job at send time): `priority` LOWER is tried first; routes with
 *       the same priority share load by `weight` (0 = only when the others cannot take it).
 *       A job leaves its primary group (all active routes at the lowest priority, usable or
 *       not) for a later one only if EVERY route of that group has `fallback_allowed` —
 *       even while the primary's provider is disabled, tripped or keyless (then the job
 *       waits, and new requests get 503 AI_UNAVAILABLE) — and only when the primary's circuit is open (5 refusals in 2 min)
 *       or it was refused at the door, or — spillover — the primary has no rate budget and
 *       the job has waited `ai_spillover_wait_seconds`. A task that fails after starting is
 *       retried once on another route under the same rule (one charge). Limits: a job
 *       refused at the door (429/503) is requeued with backoff until its 5th refusal, then
 *       fails; a task that fails after starting is retried elsewhere only if it is the
 *       job's first started task (refusals never use up that retry). A job that cannot go
 *       out on a tick (no budget, no route, a circuit open) steps aside for a few seconds so
 *       it never blocks the jobs queued behind it.
 *       `max_cost_inr` skips a route whose provider_units × cost per unit exceeds it.
 *       A route jobs have used cannot be deleted (409).
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: operation_id, schema: { type: integer } }
 *       - { in: query, name: provider_id, schema: { type: integer } }
 *     responses:
 *       200: { description: Routes }
 */
router.delete('/routes/:id', ...A('ai_operations.delete'), deleteGuard(models.AiOperationRoute, aiAdmin.assertRouteDeletable));
C('/routes', {
  model: models.AiOperationRoute, resource: 'ai_route', permission: 'ai_operations',
  filterable: ['operation_id', 'provider_id', 'is_active'],
  listOptions: { order: [['operation_id', 'ASC'], ['priority', 'ASC'], ['id', 'ASC']] },
  include: [
    { model: models.AiOperation, as: 'operation', attributes: OPERATION_BRIEF },
    { model: models.AiProvider, as: 'provider', attributes: PROVIDER_BRIEF },
  ],
  createSchema: v.createRouteSchema, updateSchema: v.updateRouteSchema,
  beforeWrite: (payload, row) => aiAdmin.assertRouteWritable(payload, row),
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /admin/ai/jobs:
 *   get:
 *     summary: The AI job log, newest first
 *     description: Internal view — includes the route, model, provider task id, cost snapshot, charge/refund split and attempts count.
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string }, description: 'Comma-separated: queued,sending,processing,unknown,done,failed' }
 *       - { in: query, name: operation_key, schema: { type: string } }
 *       - { in: query, name: provider_id, schema: { type: integer } }
 *       - { in: query, name: user_id, schema: { type: integer } }
 *       - { in: query, name: error_code, schema: { type: string } }
 *       - { in: query, name: from, schema: { type: string, format: date-time } }
 *       - { in: query, name: to, schema: { type: string, format: date-time } }
 *       - { in: query, name: limit, schema: { type: integer, default: 50, maximum: 200 } }
 *       - { in: query, name: offset, schema: { type: integer, default: 0 } }
 *     responses:
 *       200: { description: Jobs; meta.total }
 * /admin/ai/jobs/{uid}:
 *   get:
 *     summary: One job with every attempt
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: The job }
 * /admin/ai/jobs/{uid}/resolve:
 *   post:
 *     summary: Close a stuck job (unknown / queued / processing) and refund the user
 *     description: Exactly once — a job that has meanwhile finished or failed answers 409.
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: uid, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [outcome], properties: { outcome: { type: string, enum: [refund] }, note: { type: string } } } } }
 *     responses:
 *       200: { description: The failed, refunded job }
 *       409: { description: Already done or failed }
 */
router.get('/jobs', ...A('ai_jobs.read'), async (req, res) => {
  const { rows, count } = await aiAdmin.listJobs(req.query);
  res.json({ success: true, data: rows, meta: { total: count } });
});

router.get('/jobs/:uid', ...A('ai_jobs.read'), async (req, res) => {
  res.json({ success: true, data: await aiAdmin.getJob(req.params.uid) });
});

router.post('/jobs/:uid/resolve', ...A('ai_jobs.update'), validate(v.resolveJobSchema), async (req, res) => {
  const data = await aiAdmin.resolveJob(req.params.uid, req.body);
  await activity.log(req, { action: 'ai_job.resolved', entityType: 'ai_job', entityId: data.id, metadata: { uid: data.uid, note: req.body.note || null } });
  res.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /admin/ai/reports/margin:
 *   get:
 *     summary: Margin per operation and route — actuals for a period, plus a stressed projection
 *     description: >
 *       `actuals`: done jobs' credits × ai_credit_value_inr against their snapshotted cost;
 *       `at_risk_inr` is the cost of failed jobs that reached the provider (we may have been
 *       billed). `projection`: every active route at today's cost with the rupee weakened by
 *       ai_fx_buffer_pct; `below_target` when under ai_target_margin_pct. `warnings` list
 *       anything that makes a number unknowable (no credit value set, no purchase recorded).
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: from, schema: { type: string, format: date-time }, description: 'Default: 30 days before `to`' }
 *       - { in: query, name: to, schema: { type: string, format: date-time }, description: 'Default: now' }
 *     responses:
 *       200: { description: '{ period, settings, warnings, actuals, projection }' }
 * /admin/ai/health:
 *   get:
 *     summary: AI health — providers, credentials present, queue depth, worker
 *     tags: [Admin - AI]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: '{ master_key_configured, worker, queue, failed_last_24h, providers[] (unavailable_reason, circuit closed|open|half_open, balance { remaining_units, bought_units, used_units, alert_below_units, low } or null) }' }
 */
router.get('/reports/margin', ...A('ai_reports.read'), async (req, res) => {
  res.json({ success: true, data: await aiAdmin.marginReport(req.query) });
});

router.get('/health', ...A('ai_reports.read'), async (req, res) => {
  res.json({ success: true, data: await aiAdmin.health() });
});

module.exports = router;
