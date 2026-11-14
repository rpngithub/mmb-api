const crypto = require('crypto');
const { INTERNAL, ProviderError } = require('../errors');

// A provider simulator for dev and tests. It never touches the network, never
// spends provider credits and never uses the shared rate limit.
//
// Behaviour comes from the route's fixed_params — so a test (or a developer)
// picks an outcome by pointing an operation at a route configured for it:
//
//   simulate           ok (default) | moderation | invalid | down | rate_limit |
//                      out_of_credits | timeout_after_send | fail_after_start
//   mode               async (default) | sync
//   complete_after_ms  async only: getStatus reports `processing` until this many
//                      ms after submit (default 0 — done on the first check)
//   output             files (default) | text — a text result instead of images
//   delay_ms          submit holds the "HTTP call" open this long (max 10 s) —
//                      a slow provider, for the worker's concurrency tests
//
// Outside production a prompt containing `[fake:<simulate>]` overrides the route,
// which is handy when clicking through the app on dev.
//
// Webhooks: signed with HMAC-SHA256 over the raw body, hex, in `x-fake-signature`,
// with the provider's webhook secret — the shape a real provider uses, so the
// verification path is exercised end to end. Payload:
//   { task_id, status: 'COMPLETED'|'FAILED', error?: 'moderation'|'failed' }

// A 1x1 transparent PNG — the "image" every fake job returns.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const tasks = new Map();   // taskId -> { at, simulate, n }
let clock = () => Date.now();

function behaviour(route, input) {
  const p = route.fixed_params || {};
  let simulate = p.simulate || 'ok';
  if (process.env.NODE_ENV !== 'production' && typeof input?.prompt === 'string') {
    const m = input.prompt.match(/\[fake:([a-z_]+)\]/);
    if (m) simulate = m[1];
  }
  return {
    simulate, mode: p.mode === 'sync' ? 'sync' : 'async',
    completeAfterMs: Number(p.complete_after_ms || 0), delayMs: Math.min(Number(p.delay_ms || 0), 10000),
  };
}

function files(n) {
  return Array.from({ length: Math.max(1, n || 1) }, () => ({ buffer: PNG_1PX, mime: 'image/png' }));
}

// `output: "text"` routes return a social-post shaped text result instead of files.
const FAKE_TEXT = { options: [{ caption: 'A sample caption.', hashtags: ['#sample', '#mmb'] }] };
const output = (p, n) => (p.output === 'text' ? { text: FAKE_TEXT } : { files: files(n) });

const adapter = {
  key: 'fake',
  allowedHosts: ['fake.invalid'],
  requiresApiKey: false,

  validateRoute({ model }) {
    if (!model) return 'model is required';
    return null;
  },

  async submit({ input, route }) {
    const b = behaviour(route, input);
    if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
    switch (b.simulate) {
      case 'moderation':     throw new ProviderError(INTERNAL.MODERATION_BLOCKED, 'before_send', { httpStatus: 422, detail: 'fake moderation' });
      case 'invalid':        throw new ProviderError(INTERNAL.INVALID_INPUT, 'before_send', { httpStatus: 400, detail: 'fake invalid' });
      case 'down':           throw new ProviderError(INTERNAL.PROVIDER_DOWN, 'before_send', { httpStatus: 503, detail: 'fake down' });
      case 'rate_limit':     throw new ProviderError(INTERNAL.RATE_LIMITED, 'before_send', { httpStatus: 429, detail: 'fake 429', retryAfterMs: 1000 });
      case 'out_of_credits': throw new ProviderError(INTERNAL.PROVIDER_OUT_OF_CREDITS, 'before_send', { httpStatus: 402, detail: 'fake balance' });
      case 'timeout_after_send': throw new ProviderError(INTERNAL.TIMEOUT, 'after_send', { detail: 'fake timeout' });
      default: break;
    }
    const n = Number(input?.num_images || 1);
    const p = route.fixed_params || {};
    if (b.mode === 'sync') return { kind: 'sync', ...output(p, n), providerUnits: p.output === 'text' ? 0.05 : undefined };

    const taskId = `fake_${crypto.randomUUID()}`;
    tasks.set(taskId, { at: clock(), ...b, n, p });
    return { kind: 'async', taskId };
  },

  async getStatus({ taskId }) {
    const t = tasks.get(taskId);
    // Unknown to this process (restarted, or another instance): report done so
    // dev jobs never hang. Real adapters ask the provider.
    if (!t) return { state: 'done', files: files(1) };
    if (clock() - t.at < t.completeAfterMs) return { state: 'processing' };
    if (t.simulate === 'fail_after_start') {
      return { state: 'failed', error: new ProviderError(INTERNAL.TASK_FAILED, 'after_start', { detail: 'fake task failure' }) };
    }
    return { state: 'done', ...output(t.p, t.n) };
  },

  verifyWebhook({ rawBody, headers, secrets }) {
    const sig = String(headers['x-fake-signature'] || '');
    if (!sig || !rawBody) return false;
    const given = Buffer.from(sig, 'utf8');
    return (secrets || []).some((secret) => {
      const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8');
      return expected.length === given.length && crypto.timingSafeEqual(expected, given);
    });
  },

  parseWebhook({ body }) {
    const taskId = body?.task_id;
    if (!taskId) return null;
    if (body.status === 'COMPLETED') {
      const t = tasks.get(taskId);
      return { taskId, state: 'done', files: files(t?.n || 1) };
    }
    if (body.status === 'FAILED') {
      const code = body.error === 'moderation' ? INTERNAL.MODERATION_BLOCKED : INTERNAL.TASK_FAILED;
      return { taskId, state: 'failed', error: new ProviderError(code, 'after_start', { detail: 'fake webhook failure' }) };
    }
    return { taskId, state: 'processing' };
  },

  normalizeError(err) {
    if (err instanceof ProviderError) return err;
    return new ProviderError(INTERNAL.UNKNOWN, 'after_send', { detail: 'fake unknown' });
  },

  async verifyCredential() { return true; },

  // Test hooks.
  _tasks: tasks,
  _setClock(fn) { clock = fn || (() => Date.now()); },
  PNG_1PX,
};

module.exports = adapter;
