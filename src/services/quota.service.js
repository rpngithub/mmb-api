const { v4: uuid }    = require('uuid');
const sequelize       = require('../config/db');
const planFeatureRepo = require('../repositories/planFeature.repository');
const featureTypeRepo = require('../repositories/featureType.repository');
const userSubRepo     = require('../repositories/userSubscription.repository');
const planRepo        = require('../repositories/plan.repository');
const userRepo        = require('../repositories/user.repository');
const quotaRepo       = require('../repositories/userQuotaUsage.repository');
const counterRepo     = require('../repositories/userQuotaCounter.repository');
const grantRepo       = require('../repositories/userQuotaGrant.repository');
const eventRepo       = require('../repositories/quotaUsageEvent.repository');
const notify          = require('./notification.service');
const dedupe          = require('../utils/dedupeKey');
const { SOURCES, FALLBACK, labelFor } = require('../constants/quotaSources');
const { METERS, scaleFor, unitFor, modeOf } = require('../constants/quotaMeters');
const { isRelaxed }   = require('../config/quota');
const { QuotaError }  = require('../errors');

// Which meters exist, their units, and how usage of each is counted all live in
// constants/quotaMeters.js. Counters are rows in user_quota_counters keyed by
// feature type, so this file never names a column.
//
// How a meter behaves is read off its feature type's reset_period (modeOf), and
// decides what a purchased top-up DOES to it:
//
//   gauge — reset 'never'. Usage is an occupancy LEVEL that only moves when
//           something is added or removed (storage bytes, frames on the shelf).
//           A top-up permanently raises the ceiling, and freeing space returns
//           the purchased headroom on its own, so nothing is ever debited from
//           the grant.
//   flow  — reset monthly/annual. Usage is a TALLY zeroed every cycle. A top-up
//           cannot just raise the ceiling here, because the reset would hand the
//           same purchased credits back every month forever. Spending is SPLIT
//           instead: the plan allowance fills first and the remainder is debited
//           against the grant, which never resets.
//
// Limits: plan_features.value is an INTEGER and storage is expressed there in
// MEGABYTES while its counter is in BYTES (scaleFor). Storage stays in MB in
// plan_features on purpose: the column is a signed INT, so a byte-valued limit
// would overflow just past 2 GB. quota_packs.quantity follows the same convention.

const round2 = (n) => Math.round(n * 100) / 100;

// A meter whose gauge usage is counted from live rows rather than a counter —
// see `liveCount` in constants/quotaMeters.js.
const isLive = (ft) => Boolean(METERS[ft.key]?.liveCount) && modeOf(ft) === 'gauge';

// ---------------------------------------------------------------------------
// Which plan the account is held to
// ---------------------------------------------------------------------------

// The active subscription's plan, or — for an account without one — the plan
// with plan_type 'free'. `anchor` is the date the monthly window counts from:
// the subscription start, or the signup date on the free plan. Null when there
// is no subscription and no active free plan, in which case nothing is enforced
// (usage is still recorded, so enabling the free plan later needs no backfill).
async function effectivePlan(userId) {
  const sub = await userSubRepo.findActiveByUser(userId);
  if (sub) return { planId: sub.plan_id, anchor: sub.starts_at, isFree: false };

  const free = await planRepo.findFree();
  if (!free) return null;
  const user = await userRepo.findById(userId, { attributes: ['created_at'] });
  return { planId: free.id, anchor: user?.created_at || null, isFree: true };
}

// ---------------------------------------------------------------------------
// Plan allowance
// ---------------------------------------------------------------------------

// The limit in the same unit as the counter, or null for unlimited/unset.
//
// This is the single choke point for "is this account held to a limit?", so the
// relaxation switch belongs here and nowhere else: enforcement, `remaining`, the
// presign pre-check, `/subscriptions/me`, `/quota/usage` and the top-up purchase
// guard all derive from it, and they stay consistent with each other for free.
async function limitFor(userId, featureKey) {
  // Enforcement suspended for this feature — see config/quota.js. Usage keeps
  // being recorded by `consume` below, so switching it back on needs no backfill.
  if (isRelaxed(featureKey)) return null;

  const plan = await effectivePlan(userId);
  if (!plan) return null;

  const value = await planFeatureRepo.getFeatureValue(plan.planId, featureKey);
  if (value === null || value === -1) return null;   // unset / unlimited
  return value * scaleFor(featureKey);
}

// What the account has used of one feature, in counter units.
async function usedFor(userId, ft, transaction) {
  if (isLive(ft)) return METERS[ft.key].liveCount(userId);
  return counterRepo.used(userId, ft.id, transaction);
}

// ---------------------------------------------------------------------------
// Purchased balance
// ---------------------------------------------------------------------------

// A user's top-up balance for one feature, in COUNTER units.
//
// `remaining` is granted - consumed in both modes, which works because a gauge
// never debits: its `consumed` stays 0, so remaining is the whole purchased
// ceiling — exactly what should be added to the plan limit. That is what lets
// enforcement below stay a single expression for both shapes.
async function balanceFor(userId, featureKey, transaction) {
  const ft = await featureTypeRepo.findByKey(featureKey);
  if (!ft) return { granted: 0, consumed: 0, remaining: 0, featureTypeId: null };

  const { granted, consumed } = await grantRepo.balanceFor(userId, ft.id, transaction);
  const scale = scaleFor(featureKey);

  return {
    granted:       granted * scale,
    consumed:      consumed * scale,
    remaining:     Math.max(granted - consumed, 0) * scale,
    featureTypeId: ft.id,
  };
}

// ---------------------------------------------------------------------------
// Billing period (lazy reset)
// ---------------------------------------------------------------------------

// Add whole months without the end-of-month overflow `setMonth` has on its own:
// 31 Jan + 1 month is 3 Mar to a raw setMonth, because February has no 31st.
// Collapsing to the 1st before moving the month and clamping to the new month's
// last day gives 28 (or 29) Feb instead.
function addMonthsClamped(date, months) {
  const d   = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

// DATEONLY columns are compared and stored as plain calendar dates. Formatting
// via toISOString() would render them in UTC, which in IST turns any local
// midnight into the previous day.
const dateOnly = (d) => [
  d.getFullYear(),
  String(d.getMonth() + 1).padStart(2, '0'),
  String(d.getDate()).padStart(2, '0'),
].join('-');

// A DATEONLY string ('2026-09-12') as a LOCAL date, the inverse of dateOnly().
// `new Date('2026-09-12')` would parse it as UTC midnight — the previous day in IST.
const parseDateOnly = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
};

// How many whole months after `anchor` the window containing `date` starts.
//
// Every boundary is measured from the ORIGINAL anchor, never from the previous
// boundary. That matters because clamping is lossy: a 31 Jan anchor clamps to
// 28 Feb, and stepping forward from there would pin every later month to the
// 28th.
function windowIndex(anchor, date) {
  let months = 0;
  while (addMonthsClamped(anchor, months + 1) <= date) months += 1;
  return months;
}

// The monthly window the account is currently in, or null when there is no
// anchor to compute one from.
//
// Monthly REGARDLESS of billing cycle: an annual subscriber still gets their
// credits back every month, because that is what feature_types.reset_period says.
// The anchor is the subscription's start date (the signup date on the free plan),
// so the reset lands on the same day of the month every time — the date the app
// shows them.
async function currentWindow(userId, now = new Date(), plan = undefined) {
  const held = plan !== undefined ? plan : await effectivePlan(userId);
  // No plan at all means no enforcement and no anchor, so there is nothing to
  // reset and no honest date to show.
  if (!held || !held.anchor) return null;

  // The start is the offset before the end rather than the end stepped back a
  // month: going back a month from a clamped 28 Feb lands on 28 Jan — a period
  // that never started.
  const anchor = new Date(held.anchor);
  const index  = windowIndex(anchor, now);

  return {
    start: dateOnly(addMonthsClamped(anchor, index)),
    end:   dateOnly(addMonthsClamped(anchor, index + 1)),
    index,
  };
}

// The feature types whose tallies start again when the window rolls from
// `previousStart` to `window`: every monthly flow, and the annual ones when a
// year boundary was crossed. Gauges never — that would hand out free space.
async function recurringFeatureIds(plan, window, previousStart) {
  const anchor  = new Date(plan.anchor);
  const before  = previousStart ? windowIndex(anchor, parseDateOnly(previousStart)) : window.index;
  const newYear = Math.floor(window.index / 12) > Math.floor(before / 12);

  const types = await featureTypeRepo.findMany({ data_type: 'integer' });
  return types
    .filter((ft) => ft.reset_period === 'monthly' || (ft.reset_period === 'annual' && newYear))
    .map((ft) => ft.id);
}

// Roll the account onto its current period if the stored one has run out.
//
// Called at the top of every read and write below rather than from a cron: the
// usage row is already being fetched on those paths, a dormant account resets
// correctly the moment it comes back, and there is no sweep to miss.
async function ensureCurrentPeriod(userId) {
  const usage = await quotaRepo.findByUserId(userId);
  if (!usage) return null;   // nothing recorded yet; the window is stamped on first use

  if (usage.period_end && new Date(usage.period_end) > new Date()) {
    return { start: usage.period_start, end: usage.period_end };
  }

  const plan   = await effectivePlan(userId);
  const window = await currentWindow(userId, new Date(), plan);
  if (!window) return null;

  if (usage.period_end) {
    const resetIds = await recurringFeatureIds(plan, window, usage.period_start);
    await sequelize.transaction(async (transaction) => {
      await counterRepo.reset(userId, resetIds, transaction);
      await quotaRepo.setPeriod(userId, window.start, window.end, transaction);
    });

    // The window just rolled. This is where the "your credits have been refreshed"
    // notification belongs — there is no monthly cron to hang it off, because the
    // reset itself is lazy (see the comment above). A dormant user is told the
    // moment they come back, which is exactly when it is useful.
    //
    // Free and paid get different copy, per the sheet; the dedupe key is the new
    // period start, so the many callers of this function in one request produce
    // one notification.
    const code = plan.isFree ? 'free_credits_refreshed' : 'credits_reset';
    notify.notify({ code, userId, dedupeKey: dedupe.forPeriod(code, window.start) });
  } else {
    // First window this account has ever had. Its counters were accumulated with
    // no period at all, so adopt them as this period's usage rather than zeroing:
    // wiping them would hand every existing account a fresh allowance for work
    // they have already done.
    await quotaRepo.setPeriod(userId, window.start, window.end);
  }

  return { start: window.start, end: window.end };
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

// Throws QuotaError when consuming `by` more would take the user past everything
// available to them — the plan allowance PLUS whatever top-up balance they have
// bought. `by` is in counter units (bytes for storage, 1 per action for the
// counters), so a single call covers "may I upload 4 MB?" and "may I download
// once?".
async function assertWithinQuota(userId, featureKey, by = 1) {
  await ensureCurrentPeriod(userId);

  const limit = await limitFor(userId, featureKey);
  if (limit === null) return;

  const ft    = await featureTypeRepo.findByKey(featureKey);
  const used  = ft ? await usedFor(userId, ft) : 0;
  const topup = (await balanceFor(userId, featureKey)).remaining;

  if (used + by > limit + topup) {
    throw new QuotaError(`${ft?.label || featureKey} limit reached. Upgrade your plan or buy a top-up.`);
  }
}

// For putting back something that was taken off a live-counted gauge (restoring
// an archived project): it occupies a slot again, so there has to be one. On a
// flow the item was already counted when it was first added, and restoring it is
// not a new add — nothing to check.
async function assertRoomToRestore(userId, featureKey) {
  const ft = await featureTypeRepo.findByKey(featureKey);
  if (ft && isLive(ft)) await assertWithinQuota(userId, featureKey, 1);
}

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

// A spend attributed to a source that belongs to a different feature is a wiring
// mistake, not something a user did — fail loudly rather than write a row that
// makes the breakdown lie.
function assertSourceMatches(source, featureKey) {
  const known = SOURCES[source];
  if (known && known.feature !== featureKey) {
    throw new Error(
      `quota source '${source}' belongs to '${known.feature}', not '${featureKey}'`,
    );
  }
}

// Debit `amount` (FEATURE units) against the user's active grants, oldest first.
// Returns what was actually taken, which can fall short of `amount` if a
// concurrent spend got there first — the guarded UPDATE in the repository is what
// makes that a short debit rather than an overdraw.
async function debitGrants(userId, featureTypeId, amount, transaction) {
  let left = amount;

  const grants = await grantRepo.findSpendable(userId, featureTypeId, transaction);
  for (const grant of grants) {
    if (left <= 0) break;
    const room = Number(grant.quantity) - Number(grant.consumed);
    const take = Math.min(room, left);
    if (take <= 0) continue;
    if (await grantRepo.debit(grant.id, take, transaction)) left -= take;
  }

  return amount - left;
}

// Increments usage, creating the user's window row on first use. Always recorded,
// including for accounts no limit applies to (see limitFor).
//
// For a FLOW whose plan allowance is already spent, the excess is debited against
// the purchased balance instead of the counter — so the counter never exceeds the
// plan limit and stays safe to zero at the cycle boundary, while the purchased
// credits are permanently spent and survive it.
//
// A live-counted gauge (frames, brand series, template projects kept) has no
// counter to move: the row the caller just created IS the usage. Only the ledger
// event is written, for the breakdown.
//
// `opts.source` attributes the spend for the usage breakdown; see
// constants/quotaSources.js.
async function consume(userId, featureKey, by = 1, opts = {}) {
  if (by <= 0) return;

  const { source = FALLBACK, ref_type = null, ref_id = null } = opts;
  assertSourceMatches(source, featureKey);

  await ensureCurrentPeriod(userId);

  const ft = await featureTypeRepo.findByKey(featureKey);
  // No feature type means nothing to count against and no plan that could limit
  // it — there is nowhere to record the spend.
  if (!ft) return;

  const limit = await limitFor(userId, featureKey);
  const scale = scaleFor(featureKey);

  await sequelize.transaction(async (transaction) => {
    if (!(await quotaRepo.findOne({ user_id: userId }, { transaction }))) {
      await quotaRepo.create({ user_id: userId }, transaction);
    }

    // Everything lands on the counter unless this is a metered flow that has
    // already used up its plan allowance. An unmetered account (limit null) never
    // touches its purchased balance: it is not being held to a limit, so there is
    // nothing for the top-up to be spent on.
    let fromPlan  = by;
    let fromTopup = 0;

    if (modeOf(ft) === 'flow' && limit !== null) {
      const used         = await counterRepo.used(userId, ft.id, transaction);
      const planHeadroom = Math.max(limit - used, 0);
      fromPlan  = Math.min(by, planHeadroom);
      fromTopup = by - fromPlan;
    }

    if (fromPlan > 0 && !isLive(ft)) {
      await counterRepo.increment(userId, ft.id, fromPlan, transaction);
    }

    if (fromTopup > 0) {
      // Grants are denominated in feature units; only flows are ever debited and
      // every flow feature has scale 1, so this is an identity today. It is still
      // written out so marking a scaled feature as a flow later cannot silently
      // debit bytes against a balance counted in megabytes.
      const debited = await debitGrants(userId, ft.id, fromTopup / scale, transaction);
      // A short debit means a concurrent spend took the balance between the check
      // and here. Charge only what was actually covered rather than inventing
      // headroom; the next call will fail the check cleanly.
      fromTopup = debited * scale;
    }

    await eventRepo.create({
      uid: uuid(), user_id: userId, feature_type_id: ft.id,
      source, amount: fromPlan + fromTopup, from_plan: fromPlan, from_topup: fromTopup,
      ref_type, ref_id,
    }, transaction);
  });

  // "Only N AI credits remaining." Deliberately AFTER the transaction: a
  // notification must never be able to roll back a spend, or hold locks while it
  // runs its own queries.
  await _maybeWarnLowBalance(userId, featureKey);
}

// Fires `credits_running_low` once per billing period, not once per spend — the
// dedupe key is the period start, so the twentieth AI call after crossing the
// threshold is silent. Only metered flows can run low; a gauge (storage) has its
// own upload-time errors and an unmetered account has nothing to warn about.
const LOW_BALANCE_RATIO = 0.15;

async function _maybeWarnLowBalance(userId, featureKey) {
  try {
    if (featureKey !== 'ai_credits') return;

    const limit = await limitFor(userId, featureKey);
    if (limit === null || limit <= 0) return;      // unmetered — nothing to warn about

    const left = await remaining(userId, featureKey);
    if (left === null || left <= 0) return;        // already exhausted; the 402 says so
    if (left > Math.ceil(limit * LOW_BALANCE_RATIO)) return;

    const window = await currentWindow(userId);
    await notify.notify({
      code: 'credits_running_low', userId,
      variables: { credits_count: left },
      dedupeKey: dedupe.forPeriod('credits_running_low', window?.start || new Date()),
    });
  } catch (err) {
    // Best-effort, like activity.log: a warning must never fail the spend that
    // triggered it.
    console.error('[quota] low-balance notify failed:', err.message);
  }
}

// Gives usage back — storage freed when a file is deleted. Floored at zero in the
// repository so a double release (or a counter that predates the ledger) can
// never drive it negative and hand out free storage.
//
// Only counter-backed GAUGES are released, and only the counter moves: lowering
// occupancy automatically frees the purchased ceiling again. A flow is
// deliberately not credited back — a spent credit is spent, and refunding one
// would need a deliberate admin grant, not an automatic reversal. A live-counted
// gauge needs no release at all: deleting the row is the release.
async function release(userId, featureKey, by = 1, opts = {}) {
  if (by <= 0) return;

  const ft = await featureTypeRepo.findByKey(featureKey);
  if (!ft || modeOf(ft) !== 'gauge' || isLive(ft)) return;

  const { source = FALLBACK, ref_type = null, ref_id = null } = opts;
  await counterRepo.decrement(userId, ft.id, by);

  // Negative, so summing the ledger reconciles against the counter.
  await eventRepo.create({
    uid: uuid(), user_id: userId, feature_type_id: ft.id,
    source, amount: -by, from_plan: -by, from_topup: 0, ref_type, ref_id,
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

// All three numbers for one feature, in counter units (bytes for storage).
// `limit` and `remaining` are null when unlimited or unenforced; `used` is always
// a number, because usage is recorded even for accounts no limit applies to — so
// a free account can still be shown what it has consumed. `remaining` includes
// any purchased balance, since that is what the account can actually still do.
async function snapshot(userId, featureKey) {
  await ensureCurrentPeriod(userId);

  const limit = await limitFor(userId, featureKey);
  const ft    = await featureTypeRepo.findByKey(featureKey);
  const used  = ft ? await usedFor(userId, ft) : 0;
  const topup = await balanceFor(userId, featureKey);

  return {
    limit,
    used,
    topup_granted:   topup.granted,
    topup_remaining: topup.remaining,
    remaining: limit === null
      ? null
      : Math.max(limit + topup.granted - used - topup.consumed, 0),
  };
}

// Remaining headroom in counter units, or null when unlimited/unenforced. Used to
// tell a client how much room is left before they start an upload.
async function remaining(userId, featureKey) {
  return (await snapshot(userId, featureKey)).remaining;
}

// One feature's entitlement, as both `GET /subscriptions/me` and `GET
// /quota/usage` report it. Kept here, rather than in either endpoint, so the two
// cannot drift: the app gates on the first and renders the Usage screen from the
// second, and they disagreeing would show a user headroom they do not have.
//
// `rawUsed` is in counter units (bytes for storage). `limit` remains the PLAN
// limit — existing clients read it that way — with the purchased ceiling reported
// separately as `topup_granted` and folded into `effective_limit` and `remaining`.
function buildFeature(pf, rawUsed, balance) {
  const ft      = pf.FeatureType;
  // Enforcement suspended: report it the way the account is actually treated, or
  // the app would draw a full red bar and offer a top-up for a limit nothing is
  // applying. `enforced: false` keeps that honest — the plan still SAYS 100 MB,
  // it just is not being held to it — and `topupable` goes false to match the
  // purchase guard, which refuses to sell headroom nobody needs.
  const relaxed = isRelaxed(ft.key);
  const base = {
    key: ft.key, label: ft.label, reset_period: ft.reset_period,
    data_type: ft.data_type, topupable: Number(ft.is_topupable) === 1 && !relaxed,
    ...(relaxed ? { enforced: false } : {}),
  };
  if (ft.data_type === 'boolean') return { ...base, enabled: pf.value === 1 };

  const unlimited = pf.value === -1 || relaxed;
  const scale     = scaleFor(ft.key);                      // bytes per unit (1 for counts)
  const used      = scale === 1 ? Number(rawUsed || 0) : round2(Number(rawUsed || 0) / scale);

  // Balances are already in feature units here — they come straight off the grant
  // rows, which use the same unit as plan_features.value.
  const granted  = Number(balance?.granted  || 0);
  const consumed = Number(balance?.consumed || 0);

  return {
    ...base,
    unit:      unitFor(ft.key),
    limit:     unlimited ? null : pf.value,
    unlimited,
    used,
    topup_granted:   granted,
    topup_remaining: Math.max(granted - consumed, 0),
    // Plan allowance plus everything bought — the number the bar fills against
    // once a top-up has been applied.
    effective_limit: unlimited ? null : round2(pf.value + granted),
    // A gauge keeps `consumed` at 0, so this one expression is right for both
    // shapes: level-based features subtract only occupancy, tallies also subtract
    // what has been spent out of the purchased pool.
    remaining: unlimited ? null : round2(Math.max(pf.value + granted - used - consumed, 0)),
    ...(scale === 1 ? {} : { used_bytes: Number(rawUsed || 0) }),
  };
}

// The plan whose features the Usage screen lists: the active subscription's, or
// the free plan for an account without one. `sub` is the detailed subscription
// row when the caller already has it, `null` for "known to have none".
async function _summaryPlan(userId, sub) {
  const active = sub !== undefined ? sub : await userSubRepo.findActiveDetailed(userId);
  if (active) return active.Plan || null;
  return planRepo.findFree({ withFeatures: true });
}

// The whole Usage screen for one user: the current period, and every feature the
// plan they are held to declares — the subscription's, or the free plan's — with
// its allowance, purchased balance and, when asked for, the per-tool breakdown.
//
// `withBreakdown` is off by default because it costs a GROUP BY per feature, and
// `GET /subscriptions/me` is polled after checkout while the Usage screen is
// opened deliberately.
// `sub` may be passed in by a caller that has already loaded it — the detailed
// row is a three-level include, and `/subscriptions/me` is polled after checkout.
async function usageSummary(userId, { withBreakdown = false, sub = undefined } = {}) {
  const period = await ensureCurrentPeriod(userId);
  const plan   = await _summaryPlan(userId, sub);
  if (!plan) return { period, features: [] };

  const counters = await counterRepo.usedMap(userId);
  const balances = await grantRepo.balancesFor(userId);

  const planFeatures = (plan.PlanFeatures || [])
    .filter((pf) => pf.FeatureType)
    .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

  const features = [];
  for (const pf of planFeatures) {
    const ft   = pf.FeatureType;
    const used = ft.data_type === 'boolean' ? 0
      : isLive(ft) ? await METERS[ft.key].liveCount(userId)
      : (counters.get(Number(ft.id)) || 0);
    const feature = buildFeature(pf, used, balances.get(Number(ft.id)));

    if (withBreakdown && ft.data_type !== 'boolean') {
      const scale = scaleFor(ft.key);
      const rows  = await eventRepo.breakdown(userId, ft.id, period?.start || null);
      feature.breakdown = rows.map((r) => ({
        source: r.source,
        label:  labelFor(r.source),
        used:   scale === 1 ? r.used : round2(r.used / scale),
      }));
    }

    features.push(feature);
  }

  return { period, features };
}

// Boolean plan features (data_type 'boolean', value 1/0) — "may this account do X
// at all", as opposed to the counters above. Read off the plan the account is
// held to, the free plan included. With no plan at all there is no entitlement:
// a paid-only capability has to be OFF by default or it is not paid-only at all.
async function hasFeature(userId, featureKey) {
  const plan = await effectivePlan(userId);
  if (!plan) return false;
  return (await planFeatureRepo.getFeatureValue(plan.planId, featureKey)) === 1;
}

module.exports = {
  assertWithinQuota, assertRoomToRestore, consume, release, remaining, snapshot, hasFeature,
  limitFor, balanceFor, usageSummary, buildFeature, effectivePlan,
  ensureCurrentPeriod, currentWindow, addMonthsClamped, scaleFor,
};
