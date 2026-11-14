const { ValidationError } = require('../../errors');

// Every provider the code can talk to. An ai_providers row whose `key` is not
// here can never be created (assertAdapterKey, the admin beforeWrite in Phase 2)
// and is ignored by the worker — the same guard quotaMeters.js gives feature
// types.
//
// THE ADAPTER CONTRACT. magnific.js (async images + one sync call) and google.js
// (sync text) are the worked examples. Every adapter:
//
//   key                  string, matches ai_providers.key
//   allowedHosts         hosts base_url and result URLs may point at
//   requiresApiKey       false only for `fake`
//   needsMediaUrls       true = media inputs arrive as { uid, url, content_type, bytes }
//                        (short-lived presigned GETs); otherwise as upload uids
//   acceptsInlineImages  true = submit also gets `attachments` [{ kind, mime, base64 }]
//                        (the job context's project thumbnail), read at send time
//   submit also always gets `context`: the job's server-side context snapshot
//                        (ai/context.js) or null
//   validateRoute({ model, fixedParams })            -> error message | null
//   checkOperation({ model, fixedParams, inputSchema }) -> [problem, …]  (optional)
//        does an operation's input schema fit this model: required fields
//        present, no field the model ignores, every enum value mappable. See
//        ai/operationCheck.js; run on every admin save of an operation or route.
//   submit({ input, route, provider, apiKey, callbackUrl })
//        -> { kind: 'async', taskId }
//         | { kind: 'sync', files?: [{ buffer|url, mime }], text?: object, providerUnits? }
//        throws ProviderError (ai/errors.js) with a code and a phase
//   getStatus({ taskId, route, provider, apiKey })
//        -> { state: 'processing'|'done'|'failed', files?, text?, error?: ProviderError, providerUnits? }
//
//   OUTPUT: `files` are copied into our S3 (media library, storage charged);
//   `text` — a JSON object — is stored on the job as-is (aiJob.service.completeJob).
//   `providerUnits` is what the call actually cost, in the provider's cost_unit
//   (token-billed providers: US cents — see google.js).
//   verifyWebhook({ rawBody, headers, secrets[] })   -> boolean, constant-time
//   parseWebhook({ body, headers })                  -> { taskId, state, files?, error? } | null
//   normalizeError(err)                              -> ProviderError
//   verifyCredential({ provider, apiKey })           -> true | throws (admin "test key")

const ADAPTERS = {
  fake:     require('./fake'),
  magnific: require('./magnific'),
  google:   require('./google'),
};

// The fake adapter makes no network calls, but a production catalogue routed to
// it would hand users a 1-pixel PNG for real credits. Refused there unless
// explicitly switched on.
function fakeAllowed() {
  return process.env.NODE_ENV !== 'production' || process.env.AI_FAKE_ENABLED === 'true';
}

function get(key) {
  if (key === 'fake' && !fakeAllowed()) return null;
  return ADAPTERS[key] || null;
}

const keys = () => Object.keys(ADAPTERS).filter((k) => get(k));

function assertAdapterKey(key) {
  if (!get(key)) {
    throw new ValidationError('Validation failed', [{ field: 'key', message: `no provider adapter named "${key}" — known: ${keys().join(', ')}` }]);
  }
}

module.exports = { get, keys, assertAdapterKey, ADAPTERS };
