// Does an operation's input schema fit the routes that fulfil it? Checked when an
// admin saves either side (aiAdmin.service), so a mismatch is a 400 in the admin
// panel instead of every user's job failing with INVALID_INPUT, or a field users
// fill in (and maybe pay for) that the provider never receives.
//
// Each adapter answers for its own models with
//   checkOperation({ model, fixedParams, inputSchema }) -> [problem, …]
// covering: required fields missing, fields the model ignores, enum values it
// cannot map, and (Google) prompt placeholders with no field behind them. An
// operation with several routes must satisfy EVERY route's adapter.

// Fields the server consumes itself, whichever adapter runs: the project (context
// builder) and, when the operation declares server-side context, the language
// and contact switch it reads, and the location that overrides the business city;
// and any field an enum option `match` validates against.
function serverFields(inputSchema) {
  const fields = (inputSchema && inputSchema.fields) || {};
  const out = new Set(Object.entries(fields).filter(([, d]) => d && d.type === 'project').map(([k]) => k));
  if (Array.isArray(inputSchema?.context) && inputSchema.context.length) {
    if (fields.language) out.add('language');
    if (fields.include_contact) out.add('include_contact');
    if (fields.location) out.add('location');
  }
  // A field another enum's `match` points at (voice_gender for a voice) is read by
  // the server's validation — its job is done before anything is sent.
  for (const def of Object.values(fields)) {
    if (def && def.type === 'enum' && def.match && typeof def.match === 'object') {
      for (const other of Object.values(def.match)) if (fields[other]) out.add(other);
    }
  }
  return out;
}

// Problems for one route, prefixed with which route it is. [] = fits.
function checkRoute(adapter, { model, fixedParams, uid }, inputSchema) {
  if (!adapter || typeof adapter.checkOperation !== 'function') return [];
  const problems = adapter.checkOperation({ model, fixedParams: fixedParams || {}, inputSchema: inputSchema || { fields: {} } }) || [];
  const label = `${adapter.key}/${model}${uid ? ` (route ${uid})` : ''}`;
  return problems.map((p) => `${label}: ${p}`);
}

module.exports = { serverFields, checkRoute };
