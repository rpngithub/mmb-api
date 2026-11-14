const providers = require('./providers');
const credentialStore = require('./credentialStore');
const secretBox = require('../utils/secretBox');

// Which route fulfils an operation, chosen at SEND time — not when the user asks —
// so a job queued during an outage can still go out once a route is usable.
//
// candidates() lists the operation's active routes on providers that can be used
// right now (active, adapter present, credential usable, not tripped), ordered by
// `priority` (LOWER number = tried first), then id. choose() then picks one per
// job: priority groups, weights within a group, the circuit breaker, spillover,
// failover and max_cost_inr — see "Choosing a route" below.

// Provider trips. A provider that rejects our key, or says our prepaid balance
// there is gone, will fail every job the same way until a human fixes it. Rather
// than let each queued job burn its attempts against the same 401, the worker
// trips the provider for TRIP_MS: it drops out of routing (new requests get
// AI_UNAVAILABLE, nothing charged; queued ones wait), Health shows why, and it is
// tried again afterwards. In memory, in the dispatcher's process — only the leader
// sends, so only the leader needs to know.
const TRIP_MS = 5 * 60 * 1000;
const trips = new Map();   // provider id -> { until, reason }

function trip(providerId, reason, ms = TRIP_MS) {
  trips.set(providerId, { until: Date.now() + ms, reason });
  console.error(`[AI] provider ${providerId} TRIPPED for ${Math.round(ms / 1000)}s: ${reason} — fix the key / top up the balance`);
}

function tripReason(providerId) {
  const t = trips.get(providerId);
  if (!t) return null;
  if (Date.now() >= t.until) { trips.delete(providerId); return null; }
  return t.reason;
}

const clearTrips = () => trips.clear();

// Why a provider cannot be used right now, or null if it can. Never throws.
async function unavailableReason(provider) {
  if (!provider || provider.status !== 'active') return 'disabled';
  const adapter = providers.get(provider.key);
  if (!adapter) return 'no_adapter';
  const tripped = tripReason(provider.id);
  if (tripped) return tripped;
  if (!adapter.requiresApiKey) return null;
  if (provider.credential_source !== 'env' && !secretBox.isConfigured()) return 'no_master_key';
  const key = await credentialStore.apiKey(provider);
  return key ? null : 'no_credential';
}

// THE PRIMARY GATE. Whether an operation's jobs may leave its primary routes is
// decided by the PRIMARY GROUP as configured — every active route at the lowest
// priority, whether or not its provider is usable right now — and it allows a
// fallback only if EVERY route in that group does. It has to be computed before
// unusable routes are dropped: otherwise a primary whose provider is tripped,
// disabled or keyless simply vanishes, the fallback becomes "the primary", and
// fallback_allowed=false is bypassed exactly when it matters (B1).
function gateOf(routes) {
  if (!routes.length) return null;
  const priority = Math.min(...routes.map((r) => Number(r.priority)));
  const primary = routes.filter((r) => Number(r.priority) === priority);
  return { priority, allowsFallback: primary.every((r) => Boolean(r.fallback_allowed)) };
}

// Usable routes for an operation, in the order they should be tried, each with
// its provider and adapter attached. The array carries `.gate` (gateOf over ALL
// active routes) for choose() and eligible().
async function candidates(operationId) {
  const { AiOperationRoute, AiProvider } = require('../models');
  const routes = await AiOperationRoute.findAll({
    where: { operation_id: operationId, is_active: true },
    include: [{ model: AiProvider, as: 'provider', required: true }],
    order: [['priority', 'ASC'], ['id', 'ASC']],
  });
  const out = [];
  for (const route of routes) {
    if (await unavailableReason(route.provider)) continue;
    out.push({ route, provider: route.provider, adapter: providers.get(route.provider.key) });
  }
  out.gate = gateOf(routes);
  return out;
}

// The candidates a job could actually be sent to under the gate: all of them when
// the primary group allows fallback, else only the primary group's. Empty = a new
// request should be refused as unavailable (nothing charged) rather than queued to
// wait for a primary that is down.
function eligible(cands) {
  const gate = cands.gate || gateOf(cands.map((c) => c.route));
  if (!gate || gate.allowsFallback) return cands;
  return cands.filter((c) => Number(c.route.priority) === gate.priority);
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
//
// Distinct from a trip. A trip is "this will fail until a human acts" (bad key,
// empty balance) and removes the provider for minutes. The circuit is "this
// provider is failing at the door right now" (503, connection refused): after
// CIRCUIT.threshold such failures inside CIRCUIT.windowMs it opens for
// CIRCUIT.openMs, during which routing skips the provider WITHOUT calling it —
// sparing users a timeout each — and sends to a fallback when the route allows.
// Then it half-opens: exactly one job is let through as a probe; success closes
// it, failure re-opens it.
//
// Only before_send PROVIDER_DOWN counts. 429 is load, handled by spillover; a
// timeout after send is ambiguous (the request may have arrived) and is not
// evidence of an outage on its own.
//
// In memory in the dispatcher (only the leader sends). With several workers this
// would move to Redis, like the token buckets.

const CIRCUIT = { threshold: 5, windowMs: 2 * 60 * 1000, openMs: 60 * 1000 };
const circuits = new Map();   // provider id -> { fails: [ms], openUntil, probingSince }

function recordFailure(providerId, nowMs = Date.now()) {
  const c = circuits.get(providerId) || { fails: [], openUntil: 0, probingSince: 0 };
  if (c.probingSince) {
    // The probe failed: straight back to open.
    Object.assign(c, { fails: [], openUntil: nowMs + CIRCUIT.openMs, probingSince: 0 });
    circuits.set(providerId, c);
    console.warn(`[AI] circuit for provider ${providerId} re-opened (probe failed)`);
    return;
  }
  c.fails = c.fails.filter((t) => nowMs - t < CIRCUIT.windowMs);
  c.fails.push(nowMs);
  if (c.fails.length >= CIRCUIT.threshold) {
    Object.assign(c, { fails: [], openUntil: nowMs + CIRCUIT.openMs });
    console.warn(`[AI] circuit for provider ${providerId} OPEN for ${CIRCUIT.openMs / 1000}s after ${CIRCUIT.threshold} failures`);
  }
  circuits.set(providerId, c);
}

function recordSuccess(providerId) {
  circuits.delete(providerId);
}

// 'closed' | 'open' | 'half_open'
function circuitState(providerId, nowMs = Date.now()) {
  const c = circuits.get(providerId);
  if (!c || !c.openUntil) return 'closed';
  if (nowMs < c.openUntil) return 'open';
  // A probe that never reported back (e.g. it went `unknown`) must not hold the
  // circuit shut forever: after another open period, allow a new probe.
  if (c.probingSince && nowMs - c.probingSince < CIRCUIT.openMs) return 'open';
  return 'half_open';
}

// Whether a send may go to this provider now; a half-open circuit admits one probe.
function admit(providerId, nowMs = Date.now()) {
  const state = circuitState(providerId, nowMs);
  if (state === 'closed') return true;
  if (state === 'open') return false;
  circuits.get(providerId).probingSince = nowMs;
  return true;
}

const clearCircuits = () => circuits.clear();

// ---------------------------------------------------------------------------
// Choosing a route for one job, at send time
// ---------------------------------------------------------------------------
//
// Routes are grouped by `priority` (LOWER first). The first group is the
// PRIMARY; routes within a group are peers that share load by `weight` (a 2–5%
// canary keeps an unused fallback from rotting). Moving to a LATER group is a
// fallback, allowed only when every route of the configured primary group has
// `fallback_allowed` (the gate — see gateOf) — so an operation where output must
// not change provider (product background: "keep my product exact") simply
// waits, even while its primary's provider is down — and only when:
//
//   - every primary-group route is circuit-open, or was just refused at the door
//     for this job (avoidRouteIds) — switching is safe, nothing started there; or
//   - SPILLOVER: the primary group has no rate budget (token bucket / concurrency)
//     and the job has waited at least `spillAfterMs`. On a normal day the queue
//     smooths bursts on the primary; only a long wait spills.
//
// Never chosen: routes in `excludeRouteIds` (this job's task already failed
// there), and routes whose estimated cost exceeds their `max_cost_inr` — so an
// expensive fallback cannot run at a loss through a long outage.
//
// Returns { cand, reason }; `cand` null means "not now" (reason says why), except
// reason 'no_route' which means nothing could ever take this job.

function estCost(cand) {
  const cpu = cand.provider.cost_per_unit_inr;
  if (cpu === null || cpu === undefined) return null;
  return Number(cand.route.provider_units || 0) * Number(cpu);
}

// Peers in weighted-random order; weight 0 routes only after every weighted one.
function weightedOrder(group, rng) {
  const pool = group.filter((c) => Number(c.route.weight) > 0);
  const zero = group.filter((c) => !(Number(c.route.weight) > 0));
  const out = [];
  while (pool.length) {
    const total = pool.reduce((s, c) => s + Number(c.route.weight), 0);
    let r = rng() * total;
    let i = 0;
    for (; i < pool.length - 1; i += 1) {
      r -= Number(pool[i].route.weight);
      if (r < 0) break;
    }
    out.push(pool.splice(i, 1)[0]);
  }
  return [...out, ...zero];
}

// `gate` defaults to the one candidates() attached, else it is derived from the
// candidates given (callers and tests that pass plain arrays).
function choose(cands, opts = {}) {
  const gate = opts.gate || cands.gate || gateOf(cands.map((c) => c.route));
  if (gate && !gate.allowsFallback) {
    const primaryOnly = cands.filter((c) => Number(c.route.priority) === gate.priority);
    const hasFallbacks = cands.length > primaryOnly.length;
    // The primary's provider is unusable right now (tripped, disabled, no key):
    // wait for it — never move the job elsewhere.
    if (!primaryOnly.length) return { cand: null, reason: 'fallback_not_allowed' };
    const r = chooseIn(primaryOnly, opts, gate);
    if (!r.cand && r.reason !== 'no_route' && hasFallbacks) return { cand: null, reason: 'fallback_not_allowed' };
    return r;
  }
  return chooseIn(cands, opts, gate);
}

function chooseIn(cands, {
  nowMs = Date.now(), waitedMs = 0, spillAfterMs = 60 * 1000,
  excludeRouteIds = new Set(), avoidRouteIds = new Set(),
  hasBudget = () => true, rng = Math.random,
} = {}, gate = null) {
  const usable = cands.filter((c) => {
    if (excludeRouteIds.has(c.route.id)) return false;
    const max = c.route.max_cost_inr;
    const cost = estCost(c);
    return !(max !== null && max !== undefined && cost !== null && cost > Number(max));
  });
  if (!usable.length) return { cand: null, reason: 'no_route' };

  const groups = [];
  for (const c of usable) {
    const last = groups[groups.length - 1];
    if (last && last[0].route.priority === c.route.priority) last.push(c);
    else groups.push([c]);
  }

  const primary = weightedOrder(groups[0], rng);
  const blocked = (c) => circuitState(c.provider.id, nowMs) === 'open' || avoidRouteIds.has(c.route.id);
  // The configured primary is not among the usable routes at all (its provider is
  // down, it is over max_cost_inr, or this job's task failed there): whatever is
  // taken now is a failover, and the gate (checked in choose) already allowed it.
  const onPrimary = !gate || Number(groups[0][0].route.priority) === gate.priority;

  // First group: the first peer that is not blocked and has budget.
  let primaryOutOfBudget = true;
  for (const c of primary) {
    if (blocked(c)) continue;
    if (!hasBudget(c)) continue;
    primaryOutOfBudget = false;
    if (admit(c.provider.id, nowMs)) return { cand: c, reason: onPrimary ? 'primary' : 'failover' };
  }

  // No fallback taken: a primary route this job was refused on is still better
  // than waiting forever — once its backoff is over, try it again (unless its
  // circuit is open).
  const sameAgain = (reason) => {
    for (const c of primary) {
      if (!avoidRouteIds.has(c.route.id) || circuitState(c.provider.id, nowMs) === 'open' || !hasBudget(c)) continue;
      if (admit(c.provider.id, nowMs)) return { cand: c, reason: 'retry_same' };
    }
    return { cand: null, reason };
  };

  if (groups.length === 1) return sameAgain(primaryOutOfBudget ? 'waiting_budget' : 'waiting_circuit');

  const allBlocked = primary.every(blocked);
  const spill = primaryOutOfBudget && waitedMs >= spillAfterMs;
  if (!allBlocked && !spill) return sameAgain('waiting_budget');

  for (const group of groups.slice(1)) {
    for (const c of weightedOrder(group, rng)) {
      if (blocked(c) || !hasBudget(c)) continue;
      if (admit(c.provider.id, nowMs)) return { cand: c, reason: allBlocked ? 'failover' : 'spillover' };
    }
  }
  return sameAgain('waiting_fallback');
}

module.exports = {
  candidates, eligible, gateOf, unavailableReason, trip, tripReason, clearTrips, TRIP_MS,
  recordFailure, recordSuccess, circuitState, admit, clearCircuits, CIRCUIT,
  choose, weightedOrder, estCost,
};
