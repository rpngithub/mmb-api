const { v4: uuid }    = require('uuid');
const sequelize       = require('../config/db');
const planFeatureRepo = require('../repositories/planFeature.repository');
const featureTypeRepo = require('../repositories/featureType.repository');
const userSubRepo     = require('../repositories/userSubscription.repository');
const quotaRepo       = require('../repositories/userQuotaUsage.repository');
const grantRepo       = require('../repositories/userQuotaGrant.repository');
const eventRepo       = require('../repositories/quotaUsageEvent.repository');
const { SOURCES, FALLBACK, labelFor } = require('../constants/quotaSources');
const { isRelaxed }   = require('../config/quota');
const { QuotaError }  = require('../errors');

// Maps a plan-feature key to its counter column on user_quota_usage.
// `storage` MUST be listed: without it the fallback below produced
// `storage_count`, a column that does not exist, so every storage read came back
// undefined -> 0 and the limit could never be reached.
const FIELD = {
  downloads:      'downloads_count',
  shares:         'shares_count',
  template_views: 'template_views_count',
  ai_credits:     'ai_credits_used',
  storage:        'storage_used_bytes',
};

// plan_features.value is an INTEGER and storage is expressed there in MEGABYTES
// (the feature_type label says "Storage (MB)"; the seed uses 100), while the
// counter is in BYTES. Everything else is a plain count, scale 1. Without this
// the two units were compared directly, so a 100 MB plan read as a 100 BYTE one.
//
// Storage stays in MB in plan_features on purpose: the column is a signed INT, so
// a byte-valued limit would overflow just past 2 GB. quota_packs.quantity follows
// the same convention, so one scale covers both sources of quota.
const LIMIT_SCALE = { storage: 1024 * 1024 };

// How a counter behaves, which decides what a purchased top-up DOES to it.
//
//   gauge — the counter is an occupancy LEVEL that only moves when something is
//           added or removed (storage bytes; lifetime view totals). A top-up
//           permanently raises the ceiling, and freeing space returns the
//           purchased headroom on its own, so nothing is ever debited from the
//           grant.
//   flow  — the counter is a TALLY zeroed every cycle. A top-up cannot just raise
//           the ceiling here, because the reset would hand the same purchased
//           credits back every month forever. Spending is SPLIT instead: the plan
//           allowance fills first and the remainder is debited against the grant,
//           which never resets.
//
// Hardcoded for the same reason FIELD is — a column name cannot be read out of a
// row. It must agree with feature_types.reset_period ('never' => gauge), and a
// test asserts exactly that against the seeded rows so the two cannot drift.
const MODE = {
  storage:        'gauge',
  template_views: 'gauge',
  downloads:      'flow',
  shares:         'flow',
  ai_credits:     'flow',
};

const fieldFor = (featureKey) => FIELD[featureKey] || `${featureKey}_count`;
const scaleFor = (featureKey) => LIMIT_SCALE[featureKey] || 1;
const modeFor  = (featureKey) => MODE[featureKey] || 'flow';

const round2 = (n) => Math.round(n * 100) / 100;

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

  const sub = await userSubRepo.findActiveByUser(userId);
  // Users without an active subscription are not enforced. This is the
  // pre-existing free-tier behaviour and is a deliberate open decision, NOT an
  // oversight — see the free-tier quota question. Usage is still RECORDED for
  // them below, so switching enforcement on later needs no backfill.
  if (!sub) return null;

  const value = await planFeatureRepo.getFeatureValue(sub.plan_id, featureKey);
  if (value === null || value === -1) return null;   // unset / unlimited
  return value * scaleFor(featureKey);
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

// The monthly window the account is currently in, or null when there is no
// anchor to compute one from.
//
// Monthly REGARDLESS of billing cycle: an annual subscriber still gets their
// credits back every month, because that is what feature_types.reset_period says.
// The anchor is the subscription's start date, so the reset lands on the same day
// of the month the customer signed up — the date the app shows them.
async function currentWindow(userId, now = new Date()) {
  const sub = await userSubRepo.findActiveByUser(userId);
  // No active subscription means no enforcement and no anchor, so there is
  // nothing to reset and no honest date to show. Becomes moot if the free tier is
  // ever brought under enforcement.
  if (!sub || !sub.starts_at) return null;

  // Every boundary is measured from the ORIGINAL anchor, never from the previous
  // boundary, and the start is the offset before the end rather than the end
  // stepped back a month. Both matter because clamping is lossy: a 31 Jan anchor
  // clamps to 28 Feb, and going back a month from there lands on 28 Jan — a
  // period that never started — while stepping forward from it would pin every
  // later month to the 28th too.
  const anchor = new Date(sub.starts_at);
  let months = 0;
  while (addMonthsClamped(anchor, months + 1) <= now) months += 1;

  return {
    start: dateOnly(addMonthsClamped(anchor, months)),
    end:   dateOnly(addMonthsClamped(anchor, months + 1)),
  };
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

  const window = await currentWindow(userId);
  if (!window) return null;

  if (usage.period_end) {
    await quotaRepo.resetPeriodCounters(userId, window.start, window.end);
  } else {
    // First window this account has ever had. Its counters were accumulated with
    // no period at all, so adopt them as this period's usage rather than zeroing:
    // wiping them would hand every existing account a fresh allowance for work
    // they have already done.
    await quotaRepo.setPeriod(userId, window.start, window.end);
  }

  return window;
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

  const usage = await quotaRepo.findByUserId(userId);
  const used  = usage ? Number(usage[fieldFor(featureKey)] ?? 0) : 0;
  const topup = (await balanceFor(userId, featureKey)).remaining;

  if (used + by > limit + topup) {
    throw new QuotaError(`${featureKey} limit reached. Upgrade your plan or buy a top-up.`);
  }
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

// Increments usage, creating the user's quota row on first use. Always recorded,
// including for users with no subscription (see limitFor).
//
// For a FLOW whose plan allowance is already spent, the excess is debited against
// the purchased balance instead of the counter — so the counter never exceeds the
// plan limit and stays safe to zero at the cycle boundary, while the purchased
// credits are permanently spent and survive it.
//
// `opts.source` attributes the spend for the usage breakdown; see
// constants/quotaSources.js.
async function consume(userId, featureKey, by = 1, opts = {}) {
  if (by <= 0) return;

  const { source = FALLBACK, ref_type = null, ref_id = null } = opts;
  assertSourceMatches(source, featureKey);

  await ensureCurrentPeriod(userId);

  const limit = await limitFor(userId, featureKey);
  const field = fieldFor(featureKey);
  const scale = scaleFor(featureKey);
  const ft    = await featureTypeRepo.findByKey(featureKey);

  await sequelize.transaction(async (transaction) => {
    let usage = await quotaRepo.findOne({ user_id: userId }, { transaction });
    if (!usage) {
      usage = await quotaRepo.create({ user_id: userId }, transaction);
    }

    // Everything lands on the counter unless this is a metered flow that has
    // already used up its plan allowance. An unmetered account (limit null) never
    // touches its purchased balance: it is not being held to a limit, so there is
    // nothing for the top-up to be spent on.
    let fromPlan  = by;
    let fromTopup = 0;

    if (modeFor(featureKey) === 'flow' && limit !== null) {
      const used         = Number(usage[field] ?? 0);
      const planHeadroom = Math.max(limit - used, 0);
      fromPlan  = Math.min(by, planHeadroom);
      fromTopup = by - fromPlan;
    }

    if (fromPlan > 0) {
      await quotaRepo.increment(userId, field, fromPlan, transaction);
    }

    if (fromTopup > 0 && ft) {
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

    if (ft) {
      await eventRepo.create({
        uid: uuid(), user_id: userId, feature_type_id: ft.id,
        source, amount: fromPlan + fromTopup, from_plan: fromPlan, from_topup: fromTopup,
        ref_type, ref_id,
      }, transaction);
    }
  });
}

// Gives usage back — storage freed when a file is deleted. Floored at zero in the
// repository so a double release (or a counter that predates the ledger) can
// never drive the column negative and hand out free storage.
//
// Only GAUGES are released today, and only the counter moves: lowering occupancy
// automatically frees the purchased ceiling again. A flow is deliberately not
// credited back — a spent credit is spent, and refunding one would need a
// deliberate admin grant, not an automatic reversal.
async function release(userId, featureKey, by = 1, opts = {}) {
  if (by <= 0) return;

  const { source = FALLBACK, ref_type = null, ref_id = null } = opts;
  await quotaRepo.decrement(userId, fieldFor(featureKey), by);

  const ft = await featureTypeRepo.findByKey(featureKey);
  if (!ft) return;

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
  const usage = await quotaRepo.findByUserId(userId);
  const used  = usage ? Number(usage[fieldFor(featureKey)] ?? 0) : 0;
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
// `limit` remains the PLAN limit — existing clients read it that way — with the
// purchased ceiling reported separately as `topup_granted` and folded into
// `effective_limit` and `remaining`.
function buildFeature(pf, usage, balance) {
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
  const rawUsed   = usage ? Number(usage[fieldFor(ft.key)] ?? 0) : 0;
  const used      = scale === 1 ? rawUsed : round2(rawUsed / scale);

  // Balances are already in feature units here — they come straight off the grant
  // rows, which use the same unit as plan_features.value.
  const granted  = Number(balance?.granted  || 0);
  const consumed = Number(balance?.consumed || 0);

  return {
    ...base,
    unit:      scale === 1 ? 'count' : 'MB',
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
    ...(scale === 1 ? {} : { used_bytes: rawUsed }),
  };
}

// The whole Usage screen for one user: the current period, and every feature the
// active plan declares with its plan allowance, purchased balance and — when
// asked for — the per-tool breakdown.
//
// `withBreakdown` is off by default because it costs a GROUP BY per feature, and
// `GET /subscriptions/me` is polled after checkout while the Usage screen is
// opened deliberately.
// `sub` may be passed in by a caller that has already loaded it — the detailed
// row is a three-level include, and `/subscriptions/me` is polled after checkout.
async function usageSummary(userId, { withBreakdown = false, sub = undefined } = {}) {
  const period = await ensureCurrentPeriod(userId);
  const active = sub !== undefined ? sub : await userSubRepo.findActiveDetailed(userId);
  if (!active) return { period, features: [] };

  const usage    = await quotaRepo.findByUserId(userId);
  const balances = await grantRepo.balancesFor(userId);

  const planFeatures = (active.Plan?.PlanFeatures || [])
    .filter((pf) => pf.FeatureType)
    .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

  const features = [];
  for (const pf of planFeatures) {
    const feature = buildFeature(pf, usage, balances.get(Number(pf.FeatureType.id)));

    if (withBreakdown && pf.FeatureType.data_type !== 'boolean') {
      const scale = scaleFor(pf.FeatureType.key);
      const rows  = await eventRepo.breakdown(userId, pf.FeatureType.id, period?.start || null);
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
// at all", as opposed to the counters above. No active subscription means no
// entitlement: unlike the usage limits, which are deliberately unenforced for
// free accounts, a paid-only capability has to be OFF by default or it is not
// paid-only at all.
async function hasFeature(userId, featureKey) {
  const sub = await userSubRepo.findActiveByUser(userId);
  if (!sub) return false;
  return (await planFeatureRepo.getFeatureValue(sub.plan_id, featureKey)) === 1;
}

module.exports = {
  assertWithinQuota, consume, release, remaining, snapshot, hasFeature,
  limitFor, balanceFor, usageSummary, buildFeature,
  ensureCurrentPeriod, currentWindow, addMonthsClamped,
  FIELD, LIMIT_SCALE, MODE, fieldFor, scaleFor, modeFor,
};
