const axios = require('axios');
const { INTERNAL, ProviderError } = require('./errors');

// The one way AI code talks HTTP. Three jobs:
//
//   1. Never leak a credential. An axios error carries `config.headers` — the API
//      key included — and anything that logs `err` prints it. Every failure leaves
//      here as a ProviderError built from scratch with the status and a short
//      body excerpt only.
//   2. Refuse hosts the adapter has not declared (`allowedHosts`), so an
//      admin-edited base_url or a URL inside a provider response cannot turn the
//      worker into an SSRF proxy, or send our key somewhere else.
//   3. Classify the failure PHASE (see ai/errors.js): a connection that was
//      refused never reached the provider (before_send, safe to requeue); a
//      timeout or reset after the request was written may have started a billed
//      task (after_send, must not be resent).
//
// Exposed as an object whose functions are called through the module
// (`http.request(...)`), so a test can replace them without a network.

const MAX_BYTES_DEFAULT = 25 * 1024 * 1024;

// Connection-level errors raised before any byte of the request reached the
// server. Everything else that is not an HTTP status (ETIMEDOUT, ECONNRESET,
// socket hang up) is treated as "may have been received".
const BEFORE_SEND = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED']);

function assertAllowedUrl(url, allowedHosts) {
  let u;
  try { u = new URL(url); } catch { throw new ProviderError(INTERNAL.INVALID_INPUT, 'before_send', { detail: 'malformed URL' }); }
  if (u.protocol !== 'https:') throw new ProviderError(INTERNAL.PROVIDER_DOWN, 'before_send', { detail: `refused non-https URL host ${u.hostname}` });
  const ok = (allowedHosts || []).some((h) => u.hostname === h || (h.startsWith('*.') && u.hostname.endsWith(h.slice(1))));
  if (!ok) throw new ProviderError(INTERNAL.PROVIDER_DOWN, 'before_send', { detail: `host ${u.hostname} is not allowed for this provider` });
  return u;
}

function excerpt(data) {
  if (data === undefined || data === null) return null;
  const s = Buffer.isBuffer(data) ? data.toString('utf8') : typeof data === 'string' ? data : JSON.stringify(data);
  return s.slice(0, 300);
}

/**
 * @returns {Promise<{ status, headers, data }>} for any HTTP status — the adapter
 *   maps 4xx/5xx itself, because what a 400 means differs per provider.
 * @throws ProviderError only for transport failures (no HTTP response).
 */
async function request({ method = 'GET', url, headers = {}, data, timeoutMs = 30000, allowedHosts, responseType = 'json', maxBytes = MAX_BYTES_DEFAULT }) {
  assertAllowedUrl(url, allowedHosts);
  try {
    const res = await axios.request({
      method, url, headers, data,
      timeout: timeoutMs,
      responseType: responseType === 'buffer' ? 'arraybuffer' : 'json',
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      maxRedirects: 0,                 // a redirect could leave the allowlist
      validateStatus: () => true,
    });
    const body = responseType === 'buffer' ? Buffer.from(res.data) : res.data;
    return { status: res.status, headers: res.headers || {}, data: body };
  } catch (err) {
    throw sanitize(err);
  }
}

// GET a result file. Same allowlist; returns bytes and the declared type.
async function download(url, { allowedHosts, timeoutMs = 60000, maxBytes = MAX_BYTES_DEFAULT } = {}) {
  const res = await request({ url, allowedHosts, timeoutMs, maxBytes, responseType: 'buffer' });
  if (res.status !== 200) {
    throw new ProviderError(INTERNAL.RESULT_FETCH_FAILED, 'after_start', { httpStatus: res.status, detail: `download HTTP ${res.status}` });
  }
  return { bytes: res.data, contentType: String(res.headers['content-type'] || '').split(';')[0].trim() || null };
}

// A transport error, rebuilt with nothing but its code — never the original.
function sanitize(err) {
  if (err instanceof ProviderError) return err;
  const code = err && err.code;
  if (code && BEFORE_SEND.has(code)) {
    return new ProviderError(INTERNAL.PROVIDER_DOWN, 'before_send', { detail: code });
  }
  if (code === 'ERR_BAD_RESPONSE' && /maxContentLength/.test(String(err.message))) {
    return new ProviderError(INTERNAL.RESULT_FETCH_FAILED, 'after_start', { detail: 'response too large' });
  }
  return new ProviderError(INTERNAL.TIMEOUT, 'after_send', { detail: code || 'transport error' });
}

module.exports = { request, download, sanitize, assertAllowedUrl, excerpt, MAX_BYTES_DEFAULT };
