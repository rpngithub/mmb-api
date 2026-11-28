const crypto = require('crypto');
const http = require('../http');
const { INTERNAL, ProviderError } = require('../errors');
const { serverFields } = require('../operationCheck');
const { enumValues } = require('../inputSchema');
const promptTemplate = require('../promptTemplate');

// Magnific (https://docs.magnific.com) — the adapter for our launch operations.
//
// Built from the public docs WITHOUT a live account (2026-11-09). The docs give
// paths, headers, request fields and webhook signing, but contain no JSON example
// of a text-to-image response, task status, webhook payload or error body. Every
// shape this file has to guess is marked ASSUMED and lives in one function, so the
// first real responses (captured with settings.capture_responses) can correct it in
// one place. Mappings likely to need a nudge — resolution, quality, aspect-ratio
// names, form vs JSON — are route `fixed_params`, i.e. admin data, not code.
//
// What is documented (and relied on):
//   auth           header `x-magnific-api-key`, base https://api.magnific.com
//   text-to-image  POST /v1/ai/text-to-image/<model>, async; status GET <same>/<task-id>;
//                  per-request `webhook_url`; results are URLs that expire in 30 min
//   remove bg      POST /v1/ai/beta/remove-background { image_url }, SYNCHRONOUS;
//                  response { original, high_resolution, preview, url }, 5-min URLs
//                  VERIFIED live 2026-11-20: only a URL-encoded form body is read
//                  (JSON and multipart both get "Either image_url or image_file is
//                  required") — the route needs fixed_params {"body_encoding":"form"}
//   webhooks       Standard-Webhooks style: headers webhook-id, webhook-timestamp,
//                  webhook-signature ("v1,<base64>" pairs, space-separated);
//                  HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`, base64
//   verify key     GET /v1/creations/recent?per_page=1 — "does not consume credits"
//
// The key goes ONLY into request headers built here. Errors are rebuilt from the
// response status and body (ai/http.js never lets an axios error out), so the key
// cannot reach a log, an error or a job row.

const DEFAULT_BASE = 'https://api.magnific.com';
const MAX_INPUT_BYTES = 20 * 1024 * 1024;   // documented per-image cap (remove bg; GPT edit)
const EXCERPT_CHARS = 2000;
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000; // the docs give no window; Standard Webhooks uses 5 min

// ---------------------------------------------------------------------------
// The models we route to. Keyed by ai_operation_routes.model.
// ---------------------------------------------------------------------------

const NANO = {
  family: 'nano', mode: 'async', maxImages: 1,
  resolutions: ['1K', '2K', '4K'],
  extraBody: ['use_google_search_tool', 'thinking_level'],
};
const MODELS = {
  // Nano Banana: no num_images in any documented table — one image per task.
  'nano-banana-pro':       { ...NANO, path: '/v1/ai/text-to-image/nano-banana-pro',       maxRefs: 3 },
  'nano-banana-pro-flash': { ...NANO, path: '/v1/ai/text-to-image/nano-banana-pro-flash', maxRefs: 3 },
  'nano-banana-2-1':       { ...NANO, path: '/v1/ai/text-to-image/nano-banana-2-1',       maxRefs: 14 },
  // GPT image 2: quality defaults to HIGH on Magnific's side, so it is always sent.
  'gpt-image-2': {
    family: 'gpt', mode: 'async', path: '/v1/ai/text-to-image/gpt-image-2', maxImages: 1, maxRefs: 0,
    qualities: ['low', 'medium', 'high'], resolutions: ['1k', '2k', '4k'], backgrounds: ['opaque', 'auto'],
    extraBody: [],
  },
  'gpt-image-2-5': {
    family: 'gpt', mode: 'async', path: '/v1/ai/text-to-image/gpt-image-2-5', maxImages: 10, maxRefs: 0,
    qualities: ['low', 'medium', 'high', 'xhigh', 'max'], resolutions: ['1k', '2k', '4k'],
    backgrounds: ['transparent', 'opaque', 'auto'], outputFormats: ['png', 'jpeg', 'webp'], hasNumImages: true,
    extraBody: ['variant'],
  },
  'remove-background': {
    family: 'bg', mode: 'sync', path: '/v1/ai/beta/remove-background', maxImages: 1, maxRefs: 0, extraBody: [],
  },
};

// prompt_template  the MMB prompt for this route (ai/promptTemplate.js syntax),
//                  filled from the input and the server's context; when set it IS
//                  the prompt, and the operation needs no "prompt" field
// num_images       a fixed count per request (models with num_images only); an
//                  input field of that name still wins
const FIXED_KEYS = [
  'resolution', 'quality', 'aspect_ratio', 'aspect_ratio_map', 'background', 'output_format', 'body_encoding', 'extra_body',
  'prompt_template', 'num_images',
];

const maxImagesFor = (model) => MODELS[model]?.maxImages ?? null;

// ---------------------------------------------------------------------------
// Responses — every ASSUMED shape is here.
// ---------------------------------------------------------------------------

const MODERATION_RE = /nsfw|moderat|safety|content[ _-]?polic|blocked|inappropriate|prohibited/i;
const CREDITS_RE    = /credit|balance|insufficient|top[ -]?up|payment required/i;

const textOf = (data) => {
  if (data === undefined || data === null) return '';
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return typeof data === 'string' ? data : JSON.stringify(data);
};
const excerptOf = (data) => textOf(data).slice(0, EXCERPT_CHARS) || null;

// ASSUMED: the Freepik-family task shape
//   { "data": { "task_id": "…", "status": "CREATED|IN_PROGRESS|COMPLETED|FAILED", "generated": ["https://…"] } }
// The docs only say (in prose) that results are "a URL in the `generated` array"
// and that the POST "returns a task_id immediately". Tolerant on purpose: it also
// accepts the fields at the top level, `id`, `images`, and objects with a `url`.
const DONE   = new Set(['COMPLETED', 'COMPLETE', 'SUCCEEDED', 'SUCCESS', 'DONE']);
const FAILED = new Set(['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED']);

function parseTask(body) {
  const d = (body && typeof body === 'object' && body.data && typeof body.data === 'object') ? body.data : (body || {});
  const taskId = d.task_id ?? d.id ?? body?.task_id ?? null;
  const status = String(d.status ?? body?.status ?? '').toUpperCase();
  const generated = d.generated ?? d.images ?? d.result?.generated ?? [];
  const files = (Array.isArray(generated) ? generated : [])
    .map((g) => (typeof g === 'string' ? g : g?.url))
    .filter((u) => typeof u === 'string' && u)
    .map((url) => ({ url }));

  if (DONE.has(status)) {
    if (files.length) return { taskId, state: 'done', files };
    // Completed with nothing to show — the usual way an output filter reports a
    // blocked image (ASSUMED: e.g. a `has_nsfw` flag). Never "done" with no files.
    const nsfw = Array.isArray(d.has_nsfw) ? d.has_nsfw.some(Boolean) : Boolean(d.has_nsfw);
    return {
      taskId, state: 'failed',
      error: new ProviderError(nsfw ? INTERNAL.MODERATION_BLOCKED : INTERNAL.TASK_FAILED, 'after_start', { detail: 'completed without results' }),
    };
  }
  if (FAILED.has(status)) {
    const reason = textOf(d.error ?? d.message ?? d.failure_reason ?? d.reason ?? '');
    const code = MODERATION_RE.test(reason) ? INTERNAL.MODERATION_BLOCKED : INTERNAL.TASK_FAILED;
    return { taskId, state: 'failed', error: new ProviderError(code, 'after_start', { detail: reason || status }) };
  }
  if (status && !['CREATED', 'IN_PROGRESS', 'PENDING', 'PROCESSING', 'QUEUED', 'RUNNING', 'STARTED'].includes(status)) {
    console.warn(`[AI] magnific: unrecognised task status "${status}" — treating as still processing`);
  }
  return { taskId, state: 'processing' };
}

function retryAfterMs(headers) {
  const raw = headers?.['retry-after'];
  if (raw === undefined || raw === null || raw === '') return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// An HTTP response that is not a success -> our error. Bodies are ASSUMED free
// text/JSON; only the status code is relied on, and the body is matched for the
// two cases a status alone cannot tell apart (moderation inside a 400, a balance
// problem inside a 403).
function errorFromResponse(res) {
  const s = res.status;
  const text = textOf(res.data);
  const opts = { httpStatus: s, detail: text.slice(0, 300) || `HTTP ${s}` };
  const err = (code, phase, extra = {}) => Object.assign(new ProviderError(code, phase, { ...opts, ...extra }), { responseExcerpt: excerptOf(res.data) });

  if (s === 402 || ((s === 403 || s === 400) && CREDITS_RE.test(text) && !MODERATION_RE.test(text))) return err(INTERNAL.PROVIDER_OUT_OF_CREDITS, 'before_send');
  if (s === 400 || s === 422) return err(MODERATION_RE.test(text) ? INTERNAL.MODERATION_BLOCKED : INTERNAL.INVALID_INPUT, 'before_send');
  if (s === 401 || s === 403) return err(INTERNAL.AUTH_FAILED, 'before_send');
  if (s === 429) return err(INTERNAL.RATE_LIMITED, 'before_send', { retryAfterMs: retryAfterMs(res.headers) });
  // A 404 on our own POST means the path is wrong (a model Magnific retired, as
  // it did Imagen) — a config problem, not the user's: wait and fail as unavailable.
  if (s === 404 || s === 405 || s === 502 || s === 503 || s === 504) return err(INTERNAL.PROVIDER_DOWN, 'before_send');
  // 500 and anything else: the request was received and may have started a billed
  // task. Never resent — the job goes `unknown`.
  return err(INTERNAL.TIMEOUT, 'after_send');
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const baseOf = (provider) => String(provider?.base_url || DEFAULT_BASE).replace(/\/+$/, '');

const invalid = (detail) => new ProviderError(INTERNAL.INVALID_INPUT, 'before_send', { detail });

function assertSize(ref) {
  if (ref && Number(ref.bytes) > MAX_INPUT_BYTES) throw invalid('input image is larger than 20 MB');
}

// Our input (validated against the operation's schema, media already resolved to
// presigned URLs by the worker) + the route's fixed params -> Magnific's body.
function buildBody(spec, input, fixed, callbackUrl, context = null) {
  const extra = fixed.extra_body || {};
  const body = {};

  if (spec.family === 'bg') {
    const img = input.image || input.product_image;
    if (!img?.url) throw invalid('an image is required');
    assertSize(img);
    body.image_url = img.url;
    return body;   // synchronous: no webhook
  }

  const prompt = typeof fixed.prompt_template === 'string' && fixed.prompt_template.trim()
    ? promptTemplate.render(fixed.prompt_template, input, context).trim()
    : input.prompt;
  if (!prompt) throw invalid('a prompt is required');
  body.prompt = prompt;

  const n = Number(input.num_images ?? fixed.num_images ?? 1);
  if (n > spec.maxImages) throw invalid(`this model makes at most ${spec.maxImages} image(s) per request`);

  const ar = input.aspect_ratio ?? fixed.aspect_ratio;
  if (ar) body.aspect_ratio = (fixed.aspect_ratio_map && fixed.aspect_ratio_map[ar]) || ar;
  if (fixed.resolution) body.resolution = fixed.resolution;

  const refs = [
    ...(input.product_image ? [input.product_image] : []),
    ...(Array.isArray(input.reference_images) ? input.reference_images : []),
    ...(input.image && spec.family !== 'bg' ? [input.image] : []),
  ];
  if (refs.length) {
    if (refs.length > spec.maxRefs) throw invalid(`this model accepts at most ${spec.maxRefs} reference image(s)`);
    refs.forEach(assertSize);
    // ASSUMED for nano-banana-pro (no table): the Flash / 2.1 item shape.
    body.reference_images = refs.map((r) => ({ image: r.url, ...(r.content_type ? { mime_type: r.content_type } : {}) }));
  }

  if (spec.family === 'gpt') {
    // Always explicit: Magnific's default for gpt-image-2 is the most expensive tier.
    body.quality = input.quality ?? fixed.quality ?? 'medium';
    if (!spec.qualities.includes(body.quality)) throw invalid(`quality must be one of ${spec.qualities.join(', ')}`);
    if (spec.hasNumImages) body.num_images = n;
    if (fixed.background) body.background = fixed.background;
    if (spec.outputFormats) body.output_format = fixed.output_format || 'png';
    // `moderation: low` exists on gpt-image-2-5. Never sent: a looser filter is a
    // Play Store and brand risk we do not take per request.
    if (spec.hasNumImages) body.moderation = 'auto';
  }

  for (const k of spec.extraBody) if (extra[k] !== undefined) body[k] = extra[k];
  if (callbackUrl) body.webhook_url = callbackUrl;
  return body;
}

function requestFor(spec, fixed, body) {
  if (spec.family === 'bg' && fixed.body_encoding === 'form') {
    return { data: new URLSearchParams(body).toString(), contentType: 'application/x-www-form-urlencoded' };
  }
  return { data: body, contentType: 'application/json' };
}

const headersFor = (apiKey, contentType) => ({
  'x-magnific-api-key': apiKey,
  Accept: 'application/json',
  ...(contentType ? { 'Content-Type': contentType } : {}),
});

function specFor(route) {
  const spec = MODELS[route.model];
  if (!spec) throw new ProviderError(INTERNAL.PROVIDER_DOWN, 'before_send', { detail: `unsupported model ${route.model}` });
  return spec;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

// Every key a configured secret could mean. Magnific's examples disagree: JS and
// Python HMAC with the secret as typed, PHP base64-decodes it first (the Standard
// Webhooks `whsec_` convention). `auto` tries both.
function secretKeys(secret, encoding = 'auto') {
  const raw = Buffer.from(String(secret), 'utf8');
  const stripped = String(secret).replace(/^whsec_/, '');
  const decoded = /^[A-Za-z0-9+/=_-]+$/.test(stripped) ? Buffer.from(stripped, 'base64') : null;
  if (encoding === 'raw') return [raw];
  if (encoding === 'base64') return decoded && decoded.length ? [decoded] : [];
  return [raw, ...(decoded && decoded.length ? [decoded] : [])];
}

function verifyWebhook({ rawBody, headers, secrets, provider, now = Date.now() }) {
  const id  = headers?.['webhook-id'];
  const ts  = headers?.['webhook-timestamp'];
  const sig = headers?.['webhook-signature'];
  if (!id || !ts || !sig || !rawBody || !(secrets || []).length) return false;

  const tsMs = Number(ts) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > WEBHOOK_TOLERANCE_MS) return false;

  const given = String(sig).split(' ')
    .map((part) => part.split(','))
    .filter(([v, s]) => v === 'v1' && s)
    .map(([, s]) => Buffer.from(s, 'utf8'));
  if (!given.length) return false;

  const signed = Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')]);
  const encoding = provider?.settings?.webhook_secret_encoding || 'auto';

  for (const secret of secrets) {
    for (const key of secretKeys(secret, encoding)) {
      const expected = Buffer.from(crypto.createHmac('sha256', key).update(signed).digest('base64'), 'utf8');
      if (given.some((g) => g.length === expected.length && crypto.timingSafeEqual(g, expected))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const adapter = {
  key: 'magnific',
  // api.magnific.com for calls; result files come from Magnific/Freepik CDNs (the
  // docs' sample URLs: cdn-magnific.freepik.com, cdn.freepik.com). Downloads never
  // carry the key. Widen in code — never from the admin panel — if a live response
  // shows another host.
  allowedHosts: ['api.magnific.com', '*.magnific.com', '*.freepik.com'],
  requiresApiKey: true,
  needsMediaUrls: true,
  // Magnific cannot fetch S3 presigned URLs ("Failed to download the image.",
  // verified by hand 2026-11-20) but fetches the plain object URL — so inputs go
  // as cdn_base_url + s3_key. See resolveMedia in ai/worker.js.
  mediaUrlMode: 'public',
  MODELS,
  maxImagesFor,

  // What an input image must be for this model — checked at submit, before any
  // charge. 20 MB is Magnific's documented cap; remove-background takes PNG, JPEG
  // or WEBP (the doc's "supported formats").
  inputLimits(model) {
    const spec = MODELS[model];
    if (!spec) return null;
    return spec.family === 'bg'
      ? { maxBytes: MAX_INPUT_BYTES, mimes: ['image/png', 'image/jpeg', 'image/webp'] }
      : { maxBytes: MAX_INPUT_BYTES };
  },

  validateRoute({ model, fixedParams }) {
    const spec = MODELS[model];
    if (!spec) return `model must be one of: ${Object.keys(MODELS).join(', ')}`;
    const f = fixedParams || {};
    const unknown = Object.keys(f).filter((k) => !FIXED_KEYS.includes(k));
    if (unknown.length) return `unknown fixed_params: ${unknown.join(', ')} (allowed: ${FIXED_KEYS.join(', ')})`;
    if (f.resolution !== undefined && !(spec.resolutions || []).includes(f.resolution)) {
      return spec.resolutions ? `resolution must be one of ${spec.resolutions.join(', ')} for ${model}` : `${model} takes no resolution`;
    }
    if (f.quality !== undefined && !(spec.qualities || []).includes(f.quality)) {
      return spec.qualities ? `quality must be one of ${spec.qualities.join(', ')} for ${model}` : `${model} takes no quality`;
    }
    if (f.background !== undefined && !(spec.backgrounds || []).includes(f.background)) {
      return spec.backgrounds ? `background must be one of ${spec.backgrounds.join(', ')} for ${model}` : `${model} takes no background`;
    }
    if (f.output_format !== undefined && !(spec.outputFormats || []).includes(f.output_format)) return `${model} output_format not supported`;
    if (f.background === 'transparent' && f.output_format === 'jpeg') return 'a transparent background needs png or webp';
    if (f.body_encoding !== undefined && (spec.family !== 'bg' || !['json', 'form'].includes(f.body_encoding))) {
      return 'body_encoding (json | form) applies to remove-background only';
    }
    if (f.aspect_ratio_map !== undefined && (typeof f.aspect_ratio_map !== 'object' || Array.isArray(f.aspect_ratio_map))) {
      return 'aspect_ratio_map must map our ratios to the provider\'s, e.g. {"1:1":"square_1_1"}';
    }
    if (f.prompt_template !== undefined) {
      if (spec.family === 'bg') return `${model} takes no prompt, so no prompt_template`;
      if (typeof f.prompt_template !== 'string' || !f.prompt_template.trim()) return 'prompt_template must be a non-empty string';
      const bad = promptTemplate.checkSyntax(f.prompt_template);
      if (bad) return bad;
    }
    if (f.num_images !== undefined) {
      const n = Number(f.num_images);
      if (!Number.isInteger(n) || n < 1 || n > spec.maxImages) return `num_images must be 1..${spec.maxImages} for ${model}`;
    }
    const extra = f.extra_body || {};
    const badExtra = Object.keys(extra).filter((k) => !spec.extraBody.includes(k));
    if (badExtra.length) return `extra_body may only set: ${spec.extraBody.join(', ') || '(nothing for this model)'}`;
    return null;
  },

  // Does an operation's input schema fit this model? (ai/operationCheck.js)
  checkOperation({ model, fixedParams, inputSchema }) {
    const spec = MODELS[model];
    if (!spec) return [];   // validateRoute reports an unknown model
    const f = fixedParams || {};
    const fields = inputSchema?.fields || {};
    const server = serverFields(inputSchema);
    const out = [];
    const typeIs = (k, ...types) => fields[k] && types.includes(fields[k].type);

    // What buildBody reads, per family.
    const accepts = spec.family === 'bg'
      ? ['image', 'product_image']
      : ['prompt', 'aspect_ratio', 'num_images', 'product_image', 'reference_images', 'image', ...(spec.family === 'gpt' ? ['quality'] : [])];

    const template = spec.family !== 'bg' && typeof f.prompt_template === 'string' && f.prompt_template.trim() ? f.prompt_template : null;
    const used = template ? promptTemplate.names(template) : [];

    if (spec.family === 'bg') {
      const img = typeIs('image', 'media') ? 'image' : typeIs('product_image', 'media') ? 'product_image' : null;
      if (!img) out.push('needs a required media field named "image" (or "product_image")');
      else if (!fields[img].required) out.push(`"${img}" must be required — the call fails without an image`);
    } else if (template) {
      // The template is the prompt: every name in it needs a field (or is reserved).
      for (const p of used) {
        if (!promptTemplate.RESERVED.includes(p) && !fields[p]) out.push(`prompt_template uses {{${p}}} but the operation has no "${p}" field`);
      }
      const hasContext = Array.isArray(inputSchema?.context) && inputSchema.context.length;
      for (const p of ['brand_context', 'industry', 'location']) {
        if (used.includes(p) && !hasContext) out.push(`prompt_template uses {{${p}}} but the operation declares no "context"`);
      }
    } else if (!typeIs('prompt', 'string')) {
      out.push('needs a string field "prompt"');
    } else if (!fields.prompt.required) {
      out.push('"prompt" must be required — the call fails without one');
    }

    const sendsAll = used.includes('input_json');
    for (const k of Object.keys(fields)) {
      if (!accepts.includes(k) && !server.has(k) && !used.includes(k) && !sendsAll) out.push(`field "${k}" is never sent to ${model}`);
    }
    for (const k of ['image', 'product_image']) if (fields[k] && !typeIs(k, 'media')) out.push(`"${k}" must be of type media`);
    if (fields.reference_images && !typeIs('reference_images', 'media_list')) out.push('"reference_images" must be of type media_list');

    if (spec.family !== 'bg') {
      const refs = (fields.product_image ? 1 : 0) + (fields.image ? 1 : 0)
        + (fields.reference_images ? Number(fields.reference_images.max ?? 4) : 0);
      if (refs > spec.maxRefs) out.push(`up to ${refs} reference image(s) allowed, but ${model} takes at most ${spec.maxRefs}`);
    }

    // Enum values the model cannot take.
    if (typeIs('aspect_ratio', 'enum') && f.aspect_ratio_map && typeof f.aspect_ratio_map === 'object') {
      const missing = enumValues(fields.aspect_ratio).filter((v) => !(v in f.aspect_ratio_map));
      if (missing.length) out.push(`aspect_ratio ${missing.join(', ')} has no entry in the route's aspect_ratio_map`);
    }
    if (spec.family === 'gpt' && typeIs('quality', 'enum')) {
      const bad = enumValues(fields.quality).filter((v) => !spec.qualities.includes(v));
      if (bad.length) out.push(`quality ${bad.join(', ')} is not one of ${model}'s: ${spec.qualities.join(', ')}`);
    }
    return out;
  },

  async submit({ input, route, provider, apiKey, callbackUrl, context }) {
    const spec = specFor(route);
    const fixed = route.fixed_params || {};
    const body = buildBody(spec, input || {}, fixed, spec.mode === 'async' ? callbackUrl : null, context || null);
    const { data, contentType } = requestFor(spec, fixed, body);

    const res = await http.request({
      method: 'POST', url: `${baseOf(provider)}${spec.path}`,
      headers: headersFor(apiKey, contentType), data,
      timeoutMs: Number(provider.timeout_ms) || 30000, allowedHosts: adapter.allowedHosts,
    });
    if (res.status < 200 || res.status >= 300) throw errorFromResponse(res);
    const raw = excerptOf(res.data);

    if (spec.mode === 'sync') {
      // Documented fields; `url` is "the high-resolution result".
      const d = (res.data && res.data.data) || res.data || {};
      const url = d.url || d.high_resolution;
      if (!url) {
        throw Object.assign(new ProviderError(INTERNAL.TASK_FAILED, 'after_start', { detail: 'no result url in response' }), { responseExcerpt: raw });
      }
      // The doc's rule: a transparent PNG, never a white or solid background.
      // resultStore fails (and refunds) a result that cannot hold transparency.
      return { kind: 'sync', files: [{ url, require_alpha: true }], raw };
    }

    const parsed = parseTask(res.data);
    if (!parsed.taskId) {
      // Accepted but we cannot track it: it may be running and billed. Unknown.
      throw Object.assign(new ProviderError(INTERNAL.UNKNOWN, 'after_send', { detail: 'no task id in response' }), { responseExcerpt: raw });
    }
    return { kind: 'async', taskId: String(parsed.taskId), raw };
  },

  async getStatus({ taskId, route, provider, apiKey }) {
    const spec = specFor(route);
    const res = await http.request({
      method: 'GET', url: `${baseOf(provider)}${spec.path}/${encodeURIComponent(taskId)}`,
      headers: headersFor(apiKey), timeoutMs: Number(provider.timeout_ms) || 30000, allowedHosts: adapter.allowedHosts,
    });
    if (res.status < 200 || res.status >= 300) throw errorFromResponse(res);
    const parsed = parseTask(res.data);
    return { state: parsed.state, files: parsed.files, error: parsed.error, raw: excerptOf(res.data) };
  },

  verifyWebhook,

  // ASSUMED: the webhook body is the task object, like a status response.
  parseWebhook({ body }) {
    const parsed = parseTask(body);
    if (!parsed.taskId) return null;
    return { taskId: String(parsed.taskId), state: parsed.state, files: parsed.files, error: parsed.error };
  },

  normalizeError(err) {
    if (err instanceof ProviderError) return err;
    return http.sanitize(err);
  },

  async verifyCredential({ provider, apiKey }) {
    const res = await http.request({
      method: 'GET', url: `${baseOf(provider)}/v1/creations/recent?per_page=1`,
      headers: headersFor(apiKey), timeoutMs: 15000, allowedHosts: adapter.allowedHosts,
    });
    if (res.status >= 200 && res.status < 300) return true;
    throw errorFromResponse(res);
  },

  // Exposed for tests.
  _parseTask: parseTask,
  _errorFromResponse: errorFromResponse,
  _buildBody: buildBody,
  _secretKeys: secretKeys,
};

module.exports = adapter;
