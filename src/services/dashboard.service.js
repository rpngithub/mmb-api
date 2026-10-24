const fs   = require('fs');
const path = require('path');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const ist = require('../utils/istTime');
const tzCfg = require('../config/notifications');
const { hasPermission } = require('../middlewares/authorizeAdmin');
const { ValidationError, NotFoundError } = require('../errors');

// Admin dashboard widgets.
//
// One registry entry per widget, one permission per widget: `dashboard.<key>`.
// Roles are configuration, not code — a role sees a widget only if its permission
// list grants that string (`dashboard.*` grants them all, `*` grants everything).
// So "what does Finance see" is answered by editing the role, never by a deploy.
//
// Every widget is an aggregate over tables the app already writes. Nothing here
// writes, and nothing here is on a user-facing path.
//
// Time: MMB is India-only, so "today", "this month" and every date in a series are
// IST calendar dates (see utils/istTime.js). The DB stores UTC; ranges are turned
// into real instants with istDayStart, and SQL groups by the IST-shifted date.

const MAX_RANGE_DAYS = 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const select = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

// The IST calendar date of a UTC DATETIME column, in SQL. The offset is an integer
// from config, never request input, so inlining it is safe.
const istDateSql = (col) => `DATE(DATE_ADD(${col}, INTERVAL ${parseInt(tzCfg.tzOffsetMinutes(), 10)} MINUTE))`;

// mysql2 hands DECIMAL and SUM() back as strings.
const num   = (v) => (v === null || v === undefined ? 0 : Number(v));
const money = (v) => Math.round(num(v) * 100) / 100;
const pct   = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const change = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

// A MySQL DATE comes back as 'YYYY-MM-DD' or a Date depending on driver options.
const isoOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// ---- query params --------------------------------------------------------------

function intParam(value, { name, def, min, max }) {
  if (value === undefined || value === '') return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

// An inclusive IST date range from `from`/`to` (YYYY-MM-DD). `to` defaults to
// today, `from` to `defaultDays` before `to`. The previous period is the same
// number of days immediately before, for "vs previous period" comparisons.
function resolveRange({ from, to } = {}, defaultDays = 30) {
  const t = to || ist.istDateISO();
  const f = from || ist.addDaysISO(t, -(defaultDays - 1));
  if (!DATE_RE.test(f) || !DATE_RE.test(t)) throw new ValidationError('from/to must be YYYY-MM-DD');
  // A round trip, because Date.parse happily rolls 2026-02-30 over into March.
  const real = (iso) => { const ms = Date.parse(`${iso}T00:00:00Z`); return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(iso); };
  if (!real(f) || !real(t)) {
    throw new ValidationError('from/to must be real calendar dates');
  }
  if (f > t) throw new ValidationError('from must be on or before to');
  const w = dateWindow(f, t);
  if (w.days > MAX_RANGE_DAYS) throw new ValidationError(`Range cannot exceed ${MAX_RANGE_DAYS} days`);
  return w;
}

// [from, to] inclusive as IST dates, plus the half-open UTC instants a WHERE needs.
function dateWindow(from, to) {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  return { from, to, days, start: ist.istDayStart(from), end: ist.istDayStart(ist.addDaysISO(to, 1)) };
}

const previousOf = (w) => dateWindow(ist.addDaysISO(w.from, -w.days), ist.addDaysISO(w.from, -1));
const publicRange = (w) => ({ from: w.from, to: w.to, days: w.days });

// Every IST date in a window, for gap-filling series so a chart gets a zero
// instead of a missing day.
function datesIn(w) {
  const out = [];
  for (let d = w.from; d <= w.to; d = ist.addDaysISO(d, 1)) out.push(d);
  return out;
}

// The bucket a date falls in: itself, its ISO week's Monday, or the 1st of its month.
function bucketOf(iso, granularity) {
  if (granularity === 'month') return `${iso.slice(0, 7)}-01`;
  if (granularity === 'week') {
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay() || 7;   // Mon=1 .. Sun=7
    return ist.addDaysISO(iso, 1 - dow);
  }
  return iso;
}

// Fold per-day rows into gap-filled buckets. `rows` are keyed by `day`; every
// other numeric field is summed.
function series(w, granularity, rows, fields) {
  const byDay = new Map(rows.map((r) => [isoOf(r.day), r]));
  const buckets = new Map();
  for (const d of datesIn(w)) {
    const key = bucketOf(d, granularity);
    if (!buckets.has(key)) buckets.set(key, Object.fromEntries(fields.map((f) => [f, 0])));
    const row = byDay.get(d);
    if (row) for (const f of fields) buckets.get(key)[f] += num(row[f]);
  }
  return [...buckets.entries()].map(([date, v]) => ({ date, ...v }));
}

// ---- Money -----------------------------------------------------------------

// Revenue is what was actually collected: `success` payments, dated by when they
// were paid. A refund flips the row to `refunded`, so it drops out by itself.
// `paid_at` is NULL on rows from before it existed, hence the fallback.
const PAID_AT = 'COALESCE(paid_at, created_at)';

async function revenueBetween(w) {
  const [r] = await select(
    `SELECT COALESCE(SUM(amount), 0) AS gross, COALESCE(SUM(amount_before_tax), 0) AS net, COUNT(*) AS count
       FROM payments WHERE status = 'success' AND ${PAID_AT} >= :start AND ${PAID_AT} < :end`,
    { start: w.start, end: w.end },
  );
  return { gross: money(r.gross), net: money(r.net), count: num(r.count) };
}

async function revenueSummary() {
  const today = ist.istDateISO();
  const windows = [
    { key: 'today',    label: 'Today',          w: dateWindow(today, today) },
    { key: 'last_7d',  label: 'Last 7 days',    w: dateWindow(ist.addDaysISO(today, -6), today) },
    { key: 'last_30d', label: 'Last 30 days',   w: dateWindow(ist.addDaysISO(today, -29), today) },
    { key: 'mtd',      label: 'Month to date',  w: dateWindow(`${today.slice(0, 7)}-01`, today) },
  ];
  const out = await Promise.all(windows.map(async ({ key, label, w }) => {
    const prev = previousOf(w);
    const [cur, before] = await Promise.all([revenueBetween(w), revenueBetween(prev)]);
    return {
      key, label, ...publicRange(w), ...cur,
      previous: { ...publicRange(prev), ...before },
      change_pct: change(cur.gross, before.gross),
    };
  }));
  return { currency: 'INR', windows: out };
}

// Rows from before `purchase_type` existed are all frames (see payment.model.js).
const PURCHASE_TYPES = ['subscription', 'frame', 'quota_pack'];

async function revenueTrend(query) {
  const w = resolveRange(query, 30);
  const granularity = query.granularity || 'day';
  if (!['day', 'week', 'month'].includes(granularity)) throw new ValidationError('granularity must be day, week or month');

  const rows = await select(
    `SELECT ${istDateSql(PAID_AT)} AS day,
            COALESCE(SUM(amount), 0) AS gross, COALESCE(SUM(amount_before_tax), 0) AS net, COUNT(*) AS count,
            ${PURCHASE_TYPES.map((t) => `COALESCE(SUM(CASE WHEN COALESCE(purchase_type, 'frame') = '${t}' THEN amount END), 0) AS ${t}`).join(', ')}
       FROM payments WHERE status = 'success' AND ${PAID_AT} >= :start AND ${PAID_AT} < :end
      GROUP BY day`,
    { start: w.start, end: w.end },
  );

  const points = series(w, granularity, rows, ['gross', 'net', 'count', ...PURCHASE_TYPES]).map((p) => ({
    date: p.date, gross: money(p.gross), net: money(p.net), count: p.count,
    by_type: Object.fromEntries(PURCHASE_TYPES.map((t) => [t, money(p[t])])),
  }));
  const totals = points.reduce((acc, p) => ({ gross: acc.gross + p.gross, net: acc.net + p.net, count: acc.count + p.count }),
    { gross: 0, net: 0, count: 0 });
  return { currency: 'INR', range: publicRange(w), granularity, totals: { ...totals, gross: money(totals.gross), net: money(totals.net) }, points };
}

// A pending row older than this is a checkout the user walked away from (or a
// webhook that never came). Younger ones are simply still in progress.
const STALE_PENDING_MINUTES = 30;

async function paymentHealth(query) {
  const w = resolveRange(query, 30);
  const range = { start: w.start, end: w.end };
  const [counts, reasons, recent] = await Promise.all([
    select(
      `SELECT status, COUNT(*) AS n,
              SUM(status = 'pending' AND created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${STALE_PENDING_MINUTES} MINUTE)) AS stale
         FROM payments WHERE created_at >= :start AND created_at < :end GROUP BY status`, range),
    select(
      `SELECT COALESCE(NULLIF(TRIM(failure_reason), ''), '(none recorded)') AS reason, COUNT(*) AS n
         FROM payments WHERE status = 'failed' AND created_at >= :start AND created_at < :end
        GROUP BY reason ORDER BY n DESC LIMIT 5`, range),
    select(
      `SELECT p.uid, p.amount, COALESCE(p.purchase_type, 'frame') AS purchase_type, p.payment_method,
              p.failure_reason, p.created_at, u.uid AS user_uid, u.name AS user_name
         FROM payments p JOIN users u ON u.id = p.user_id
        WHERE p.status = 'failed' AND p.created_at >= :start AND p.created_at < :end
        ORDER BY p.created_at DESC, p.id DESC LIMIT 10`, range),
  ]);

  const by = Object.fromEntries(['success', 'failed', 'pending', 'refunded'].map((s) => [s, 0]));
  let stale = 0;
  for (const r of counts) { by[r.status] = num(r.n); stale += num(r.stale); }

  return {
    range: publicRange(w),
    counts: by,
    // Of the payments that reached an outcome. Pending ones have not, yet.
    success_rate_pct: pct(by.success, by.success + by.failed),
    stale_pending: { count: stale, older_than_minutes: STALE_PENDING_MINUTES },
    top_failure_reasons: reasons.map((r) => ({ reason: r.reason, count: num(r.n) })),
    recent_failures: recent.map((r) => ({
      uid: r.uid, amount: money(r.amount), purchase_type: r.purchase_type, payment_method: r.payment_method,
      failure_reason: r.failure_reason, created_at: r.created_at,
      user: { uid: r.user_uid, name: r.user_name },
    })),
  };
}

// "Active" means the same thing it means at entitlement time: status active AND
// still inside its term. A row the renewal job has not swept yet does not count.
const ACTIVE_SUB = `s.status = 'active' AND s.ends_at > UTC_TIMESTAMP()`;

async function subscribersByPlan() {
  const [plans, [totals], [dupes]] = await Promise.all([
    select(
      `SELECT pl.uid, pl.name, pl.plan_type, s.sub_type, COUNT(*) AS n
         FROM user_subscriptions s JOIN plans pl ON pl.id = s.plan_id
        WHERE ${ACTIVE_SUB}
        GROUP BY pl.id, pl.uid, pl.name, pl.plan_type, pl.display_order, s.sub_type
        ORDER BY pl.display_order, pl.id`),
    select(
      `SELECT (SELECT COUNT(*) FROM users WHERE purged_at IS NULL AND is_active = 1) AS users,
              (SELECT COUNT(DISTINCT s.user_id) FROM user_subscriptions s WHERE ${ACTIVE_SUB}) AS subscribed`),
    // Should be zero. Non-zero is the known access-pass/recurring overlap bug
    // surfacing in real data — worth seeing before a user reports it.
    select(
      `SELECT COUNT(*) AS n FROM (
         SELECT s.user_id FROM user_subscriptions s WHERE ${ACTIVE_SUB} GROUP BY s.user_id HAVING COUNT(*) > 1
       ) d`),
  ]);

  const byPlan = new Map();
  for (const r of plans) {
    if (!byPlan.has(r.uid)) byPlan.set(r.uid, { uid: r.uid, name: r.name, plan_type: r.plan_type, total: 0, by_sub_type: { regular: 0, trial: 0, access_pass: 0 } });
    const p = byPlan.get(r.uid);
    p.total += num(r.n);
    p.by_sub_type[r.sub_type] = num(r.n);
  }

  const users = num(totals.users);
  const subscribed = num(totals.subscribed);
  return {
    plans: [...byPlan.values()],
    users_total: users,
    users_subscribed: subscribed,
    users_without_subscription: Math.max(users - subscribed, 0),
    integrity: { users_with_multiple_active_subscriptions: num(dupes.n) },
  };
}

// What happens when a subscription's term ends:
//   renews     — a live Razorpay mandate that nobody asked to stop
//   cancelling — the user cancelled renewal; the term runs out (cancel at cycle end)
//   expires    — never renewing on its own: one-time purchase, access pass, a trial
//                without a mandate
function renewalOutcome(s) {
  if (s.cancelled_at) return 'cancelling';
  if (s.auto_renew && s.razorpay_subscription_id) return 'renews';
  return 'expires';
}

async function renewalsDue(query) {
  const days  = intParam(query.days,  { name: 'days',  def: 7,  min: 1, max: 60 });
  const limit = intParam(query.limit, { name: 'limit', def: 50, min: 1, max: 200 });
  const where = `${ACTIVE_SUB} AND s.ends_at <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL :days DAY)`;

  const [rows, summary] = await Promise.all([
    select(
      `SELECT s.uid, s.sub_type, s.ends_at, s.auto_renew, s.cancelled_at, s.amount_paid, s.razorpay_subscription_id,
              pl.uid AS plan_uid, pl.name AS plan_name, u.uid AS user_uid, u.name AS user_name, u.phone AS user_phone
         FROM user_subscriptions s
         JOIN plans pl ON pl.id = s.plan_id
         JOIN users u  ON u.id = s.user_id
        WHERE ${where}
        ORDER BY s.ends_at ASC, s.id ASC LIMIT :limit`, { days, limit }),
    select(
      `SELECT s.auto_renew, s.cancelled_at IS NOT NULL AS cancelled, s.razorpay_subscription_id IS NOT NULL AS mandate, COUNT(*) AS n
         FROM user_subscriptions s WHERE ${where}
        GROUP BY s.auto_renew, cancelled, mandate`, { days }),
  ]);

  const counts = { total: 0, renews: 0, cancelling: 0, expires: 0 };
  for (const r of summary) {
    const outcome = renewalOutcome({ cancelled_at: num(r.cancelled) ? 1 : null, auto_renew: num(r.auto_renew), razorpay_subscription_id: num(r.mandate) });
    counts[outcome] += num(r.n);
    counts.total += num(r.n);
  }

  return {
    days,
    counts,
    subscriptions: rows.map((s) => ({
      uid: s.uid, sub_type: s.sub_type, ends_at: s.ends_at, amount_paid: money(s.amount_paid),
      outcome: renewalOutcome(s),
      plan: { uid: s.plan_uid, name: s.plan_name },
      user: { uid: s.user_uid, name: s.user_name, phone: s.user_phone },
    })),
  };
}

// ---- Growth ----------------------------------------------------------------

async function signupsBetween(w) {
  const [r] = await select('SELECT COUNT(*) AS n FROM users WHERE created_at >= :start AND created_at < :end', { start: w.start, end: w.end });
  return num(r.n);
}

async function userSummary() {
  const today = ist.istDateISO();
  const windows = [
    { key: 'today',    label: 'Today',        w: dateWindow(today, today) },
    { key: 'last_7d',  label: 'Last 7 days',  w: dateWindow(ist.addDaysISO(today, -6), today) },
    { key: 'last_30d', label: 'Last 30 days', w: dateWindow(ist.addDaysISO(today, -29), today) },
  ];

  // Purged rows are tombstones kept for the payment trail — not users any more.
  // `last_active_at` is stamped by touchActivity (throttled to 15 min), which makes
  // it the honest "still using the app" signal; last_login_at moves monthly.
  const [[totals], signups] = await Promise.all([
    select(
      `SELECT COUNT(*) AS total,
              SUM(is_active = 1) AS active,
              SUM(is_active = 0) AS deactivated,
              SUM(is_active = 0 AND deactivated_at IS NOT NULL) AS pending_deletion,
              SUM(last_active_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY))  AS active_1d,
              SUM(last_active_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY))  AS active_7d,
              SUM(last_active_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)) AS active_30d
         FROM users WHERE purged_at IS NULL`),
    Promise.all(windows.map(async ({ key, label, w }) => {
      const prev = previousOf(w);
      const [cur, before] = await Promise.all([signupsBetween(w), signupsBetween(prev)]);
      return { key, label, ...publicRange(w), count: cur, previous: { ...publicRange(prev), count: before }, change_pct: change(cur, before) };
    })),
  ]);

  return {
    users: {
      total: num(totals.total), active: num(totals.active), deactivated: num(totals.deactivated),
      pending_deletion: num(totals.pending_deletion),
    },
    active_users: { last_24h: num(totals.active_1d), last_7d: num(totals.active_7d), last_30d: num(totals.active_30d) },
    signups,
  };
}

// The platform a user signed up on is the client of their FIRST session. Sessions
// rotate in place and are only deleted when the account is purged, so this holds
// for everyone still on file; purged users and anyone who never completed a login
// land in `unknown`.
const PLATFORMS = ['android', 'ios', 'web', 'playground'];

async function signupsByPlatform(query) {
  const w = resolveRange(query, 30);
  const rows = await select(
    `SELECT COALESCE(s.client_type, 'unknown') AS platform, COUNT(*) AS n
       FROM users u
       LEFT JOIN user_sessions s ON s.id = (
         SELECT MIN(f.id) FROM user_sessions f WHERE f.actor_type = 'user' AND f.actor_id = u.id
       )
      WHERE u.created_at >= :start AND u.created_at < :end
      GROUP BY platform`, { start: w.start, end: w.end });

  const counts = Object.fromEntries([...PLATFORMS, 'unknown'].map((p) => [p, 0]));
  for (const r of rows) counts[PLATFORMS.includes(r.platform) ? r.platform : 'unknown'] += num(r.n);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return {
    range: publicRange(w),
    total,
    platforms: Object.entries(counts).map(([platform, count]) => ({ platform, count, pct: pct(count, total) })),
  };
}

// A cohort funnel: of the users who signed up in the range, how many have since
// reached each step. Purged users are left out — their projects and exports are
// gone, so they would read as drop-offs that never happened.
const FUNNEL_STAGES = [
  { key: 'signed_up',            label: 'Signed up (OTP verified)' },
  { key: 'onboarding_started',   label: 'Chose an account type' },
  { key: 'onboarding_completed', label: 'Finished onboarding' },
  { key: 'created_project',      label: 'Created a project' },
  { key: 'exported',             label: 'Downloaded or shared a design' },
  { key: 'paid',                 label: 'Made a payment' },
];

async function signupFunnel(query) {
  const w = resolveRange(query, 30);
  const [r] = await select(
    `SELECT COUNT(*) AS signed_up,
            COALESCE(SUM(u.account_type IS NOT NULL), 0)            AS onboarding_started,
            COALESCE(SUM(u.onboarding_completed_at IS NOT NULL), 0) AS onboarding_completed,
            COALESCE(SUM(EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id)), 0) AS created_project,
            COALESCE(SUM(EXISTS (SELECT 1 FROM project_exports e WHERE e.user_id = u.id AND e.status = 'success')), 0) AS exported,
            COALESCE(SUM(EXISTS (SELECT 1 FROM payments pm WHERE pm.user_id = u.id AND pm.status = 'success')), 0) AS paid
       FROM users u
      WHERE u.purged_at IS NULL AND u.created_at >= :start AND u.created_at < :end`,
    { start: w.start, end: w.end });

  const start = num(r.signed_up);
  let prev = start;
  const stages = FUNNEL_STAGES.map(({ key, label }) => {
    const count = num(r[key]);
    const stage = { key, label, count, pct_of_signups: pct(count, start), pct_of_previous: pct(count, prev) };
    prev = count;
    return stage;
  });
  return { range: publicRange(w), stages };
}

async function exportSummary(query) {
  const w = resolveRange(query, 30);
  const granularity = query.granularity || 'day';
  if (!['day', 'week', 'month'].includes(granularity)) throw new ValidationError('granularity must be day, week or month');
  const range = { start: w.start, end: w.end };

  const [[totals], byType, byPlatform, daily] = await Promise.all([
    select(
      `SELECT COUNT(*) AS total, SUM(status = 'success') AS success, SUM(status = 'failed') AS failed,
              SUM(status = 'pending') AS pending, COUNT(DISTINCT user_id) AS users
         FROM project_exports WHERE created_at >= :start AND created_at < :end`, range),
    select(
      `SELECT export_type, COUNT(*) AS n FROM project_exports
        WHERE created_at >= :start AND created_at < :end GROUP BY export_type`, range),
    select(
      // Alias differs from the column on purpose: MySQL resolves a GROUP BY name
      // to the COLUMN first, which would split NULL and 'direct' into two groups.
      `SELECT COALESCE(platform, 'direct') AS share_platform, COUNT(*) AS n FROM project_exports
        WHERE export_type = 'share' AND created_at >= :start AND created_at < :end GROUP BY share_platform`, range),
    select(
      `SELECT ${istDateSql('created_at')} AS day, SUM(status = 'success') AS success, SUM(status = 'failed') AS failed
         FROM project_exports WHERE created_at >= :start AND created_at < :end GROUP BY day`, range),
  ]);

  const success = num(totals.success);
  const failed  = num(totals.failed);
  return {
    range: publicRange(w),
    granularity,
    totals: { total: num(totals.total), success, failed, pending: num(totals.pending), unique_users: num(totals.users) },
    success_rate_pct: pct(success, success + failed),
    by_type: Object.fromEntries(['download', 'share'].map((t) => [t, num(byType.find((r) => r.export_type === t)?.n)])),
    shares_by_platform: Object.fromEntries(['whatsapp', 'instagram', 'facebook', 'direct'].map((p) => [p, num(byPlatform.find((r) => r.share_platform === p)?.n)])),
    points: series(w, granularity, daily, ['success', 'failed']),
  };
}

// ---- Content ---------------------------------------------------------------

// Where the catalogue is thin. A design counts once it is live (`active`); public
// browse is anchored on a template category OR an industry, so both are listed.
// Counts are DIRECT links — a parent industry is not credited with its children's
// designs, because the parent's own page shows only its own.
async function catalogCoverage(query) {
  const min   = intParam(query.min,   { name: 'min',   def: 3,  min: 1, max: 1000 });
  const limit = intParam(query.limit, { name: 'limit', def: 50, min: 1, max: 500 });

  const [industries, categories] = await Promise.all([
    select(
      `SELECT bc.uid, bc.name, bc.slug, parent.name AS parent_name,
              (SELECT COUNT(*) FROM template_business_categories tbc
                 JOIN template_families f ON f.id = tbc.family_id AND f.status = 'active'
                WHERE tbc.business_category_id = bc.id) AS active_templates
         FROM business_categories bc
         LEFT JOIN business_categories parent ON parent.id = bc.parent_id
        WHERE bc.status = 'approved' AND bc.is_active = 1`),
    select(
      `SELECT tc.uid, tc.name, tc.slug, parent.name AS parent_name,
              (SELECT COUNT(*) FROM template_families f WHERE f.category_id = tc.id AND f.status = 'active') AS active_templates
         FROM template_categories tc
         LEFT JOIN template_categories parent ON parent.id = tc.parent_id
        WHERE tc.is_active = 1`),
  ]);

  const thin = (rows) => {
    const below = rows
      .map((r) => ({ uid: r.uid, name: r.name, slug: r.slug, parent_name: r.parent_name, active_templates: num(r.active_templates) }))
      .filter((r) => r.active_templates < min)
      .sort((a, b) => a.active_templates - b.active_templates || a.name.localeCompare(b.name));
    return {
      total: rows.length,
      below_min: below.length,
      with_none: below.filter((r) => r.active_templates === 0).length,
      items: below.slice(0, limit),
    };
  };

  return { min, industries: thin(industries), template_categories: thin(categories) };
}

// Upcoming special events with too few live designs linked — the content team's
// clearest "make this next" list, with a deadline attached.
async function eventsWithoutTemplates(query) {
  const days = intParam(query.days, { name: 'days', def: 30, min: 1, max: MAX_RANGE_DAYS });
  const min  = intParam(query.min,  { name: 'min',  def: 1,  min: 1, max: 100 });
  const today = ist.istDateISO();
  const w = dateWindow(today, ist.addDaysISO(today, days - 1));

  // Recurring events store MM-DD; one-offs a concrete date. Same matching as
  // specialEvent.service#listSpecialEvents, but on the IST calendar.
  const mmddToDate = new Map();
  for (const d of datesIn(w)) if (!mmddToDate.has(d.slice(5))) mmddToDate.set(d.slice(5), d);

  const rows = await select(
    `SELECT e.uid, e.name, e.type, e.event_date, e.full_date,
            (SELECT COUNT(*) FROM special_event_templates st
               JOIN template_families f ON f.id = st.family_id AND f.status = 'active'
              WHERE st.event_id = e.id) AS active_templates
       FROM special_events e
      WHERE e.is_active = 1 AND (e.event_date IN (:mmdd) OR e.full_date BETWEEN :from AND :to)`,
    { mmdd: [...mmddToDate.keys()], from: w.from, to: w.to });

  const events = rows.map((e) => {
    const fullDate = e.full_date ? isoOf(e.full_date) : null;
    const occursOn = (e.event_date && mmddToDate.get(e.event_date))
      || (fullDate && fullDate >= w.from && fullDate <= w.to ? fullDate : null);
    return {
      uid: e.uid, name: e.name, type: e.type, occurs_on: occursOn,
      days_until: occursOn ? Math.round((Date.parse(`${occursOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) : null,
      active_templates: num(e.active_templates),
    };
  }).filter((e) => e.occurs_on)
    .sort((a, b) => a.occurs_on.localeCompare(b.occurs_on) || a.name.localeCompare(b.name));

  const short = events.filter((e) => e.active_templates < min);
  return {
    range: publicRange(w),
    min,
    upcoming_total: events.length,
    below_min: short.length,
    events: short,
  };
}

// ---- To-do -----------------------------------------------------------------

async function pendingIndustries(query) {
  const limit = intParam(query.limit, { name: 'limit', def: 20, min: 1, max: 100 });
  const [[totals], rows] = await Promise.all([
    select(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM business_categories WHERE status = 'pending'`),
    select(
      `SELECT bc.uid, bc.name, bc.created_at, parent.uid AS parent_uid, parent.name AS parent_name,
              u.uid AS user_uid, u.name AS user_name
         FROM business_categories bc
         LEFT JOIN business_categories parent ON parent.id = bc.parent_id
         LEFT JOIN users u ON u.id = bc.suggested_by_user_id
        WHERE bc.status = 'pending'
        ORDER BY bc.created_at ASC, bc.id ASC LIMIT :limit`, { limit }),
  ]);
  return {
    count: num(totals.n),
    oldest_pending_at: totals.oldest || null,
    // Oldest first: this is a queue, and the longest-waiting suggestion is the one
    // a user has been staring at the longest.
    items: rows.map((r) => ({
      uid: r.uid, name: r.name, created_at: r.created_at,
      parent: r.parent_uid ? { uid: r.parent_uid, name: r.parent_name } : null,
      suggested_by: r.user_uid ? { uid: r.user_uid, name: r.user_name } : null,
    })),
  };
}

// Aggregates only. Feedback rows carry the submitter's identity and free text, and
// reading those is `feedback.read` — a separate, narrower grant. This widget says
// whether there is something to go and read, not what it says.
async function recentFeedback(query) {
  const w = resolveRange(query, 7);
  const prev = previousOf(w);
  const [[cur], dist, platforms, [before]] = await Promise.all([
    select(
      `SELECT COUNT(*) AS n, AVG(rating) AS avg_rating, SUM(rating <= 2) AS low,
              SUM(message IS NOT NULL AND TRIM(message) <> '') AS with_message
         FROM feedbacks WHERE created_at >= :start AND created_at < :end`, { start: w.start, end: w.end }),
    select(`SELECT rating, COUNT(*) AS n FROM feedbacks WHERE created_at >= :start AND created_at < :end GROUP BY rating`,
      { start: w.start, end: w.end }),
    select(
      // Alias differs from the column — see exportSummary.
      `SELECT COALESCE(NULLIF(platform, ''), 'unknown') AS client, COUNT(*) AS n
         FROM feedbacks WHERE created_at >= :start AND created_at < :end GROUP BY client ORDER BY n DESC`,
      { start: w.start, end: w.end }),
    select('SELECT COUNT(*) AS n, AVG(rating) AS avg_rating FROM feedbacks WHERE created_at >= :start AND created_at < :end',
      { start: prev.start, end: prev.end }),
  ]);

  const avg = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
  return {
    range: publicRange(w),
    count: num(cur.n),
    average_rating: avg(cur.avg_rating),
    low_ratings: num(cur.low),
    with_message: num(cur.with_message),
    rating_distribution: Object.fromEntries([1, 2, 3, 4, 5].map((r) => [r, num(dist.find((d) => num(d.rating) === r)?.n)])),
    by_platform: platforms.map((p) => ({ platform: p.client, count: num(p.n) })),
    previous: { ...publicRange(prev), count: num(before.n), average_rating: avg(before.avg_rating) },
  };
}

// Designs still in draft, and what each is missing before it may go live. The
// checks are templatePublish#missingForFamily's, done in one query for the whole
// list instead of three per design — keep the two in step. Field keys match that
// function's `details`, so the admin panel can reuse its checklist labels.
async function draftTemplates(query) {
  const limit = intParam(query.limit, { name: 'limit', def: 20, min: 1, max: 100 });
  const checks = `
    (f.category_id IS NOT NULL OR EXISTS (SELECT 1 FROM template_business_categories tbc WHERE tbc.family_id = f.id)) AS has_anchor,
    EXISTS (SELECT 1 FROM template_tags tt WHERE tt.family_id = f.id) AS has_tag,
    EXISTS (SELECT 1 FROM templates t
             WHERE t.family_id = f.id AND t.status = 'active'
               AND (t.language_id IS NULL OR t.language_id = (SELECT l.id FROM languages l WHERE l.code = 'en'))) AS has_version`;

  const [rows, [totals]] = await Promise.all([
    select(
      `SELECT f.uid, f.name, f.template_type, f.updated_at, ${checks},
              (SELECT COUNT(*) FROM templates t WHERE t.family_id = f.id) AS versions
         FROM template_families f WHERE f.status = 'draft'
        ORDER BY f.updated_at DESC, f.id DESC LIMIT :limit`, { limit }),
    select(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(has_anchor AND has_tag AND has_version), 0) AS ready,
              COALESCE(SUM(NOT has_anchor), 0) AS no_anchor,
              COALESCE(SUM(NOT has_tag), 0) AS no_tag,
              COALESCE(SUM(NOT has_version), 0) AS no_version
         FROM (SELECT ${checks} FROM template_families f WHERE f.status = 'draft') d`),
  ]);

  const missingOf = (r) => [
    ...(num(r.has_anchor)  ? [] : ['category_id']),
    ...(num(r.has_tag)     ? [] : ['tag_ids']),
    ...(num(r.has_version) ? [] : ['versions']),
  ];

  return {
    count: num(totals.n),
    ready_to_publish: num(totals.ready),
    missing_counts: { category_id: num(totals.no_anchor), tag_ids: num(totals.no_tag), versions: num(totals.no_version) },
    items: rows.map((r) => {
      const missing = missingOf(r);
      return { uid: r.uid, name: r.name, template_type: r.template_type, versions: num(r.versions), updated_at: r.updated_at, ready: !missing.length, missing };
    }),
  };
}

// ---- System ----------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(__dirname, '../db/migrations');

// Same bookkeeping the runner uses (db/_runner.js): .js files in name order vs the
// rows in SequelizeMeta. `applied_unknown` is the other direction — the database is
// AHEAD of this build, which is what a rollback of the code without the schema
// looks like.
async function migrationStatus() {
  const files = fs.existsSync(MIGRATIONS_DIR) ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js')).sort() : [];
  let applied = [];
  try {
    applied = (await select('SELECT name FROM `SequelizeMeta` ORDER BY name')).map((r) => r.name);
  } catch {
    applied = null;   // table missing: nothing has ever been migrated here
  }
  const [{ version }] = await select('SELECT VERSION() AS version');

  const done = new Set(applied || []);
  const known = new Set(files);
  const pending = files.filter((f) => !done.has(f));
  return {
    up_to_date: applied !== null && pending.length === 0,
    run_on_boot: process.env.RUN_MIGRATIONS_ON_BOOT === 'true',
    database_version: version,
    files_total: files.length,
    applied_total: applied ? applied.length : 0,
    last_applied: applied && applied.length ? applied[applied.length - 1] : null,
    pending,
    applied_unknown: (applied || []).filter((n) => !known.has(n)),
  };
}

// ---- registry --------------------------------------------------------------

const SECTIONS = [
  { key: 'money',   title: 'Money' },
  { key: 'growth',  title: 'Growth' },
  { key: 'content', title: 'Content' },
  { key: 'todo',    title: 'To-do' },
  { key: 'system',  title: 'System' },
];

// `params` documents what each widget reads from the query string, for the admin
// panel to build its controls from. Order here is the default display order.
const RANGE = ['from', 'to'];
const WIDGETS = [
  { key: 'revenue_summary',          section: 'money',   title: 'Revenue',                          params: [],                         handler: revenueSummary },
  { key: 'revenue_trend',            section: 'money',   title: 'Revenue trend',                    params: [...RANGE, 'granularity'],  handler: revenueTrend },
  { key: 'payment_health',           section: 'money',   title: 'Payment health',                   params: RANGE,                      handler: paymentHealth },
  { key: 'subscribers_by_plan',      section: 'money',   title: 'Subscribers by plan',              params: [],                         handler: subscribersByPlan },
  { key: 'renewals_due',             section: 'money',   title: 'Renewals due',                     params: ['days', 'limit'],          handler: renewalsDue },
  { key: 'user_summary',             section: 'growth',  title: 'Users & signups',                  params: [],                         handler: userSummary },
  { key: 'signups_by_platform',      section: 'growth',  title: 'Signups by platform',              params: RANGE,                      handler: signupsByPlatform },
  { key: 'signup_funnel',            section: 'growth',  title: 'Signup funnel',                    params: RANGE,                      handler: signupFunnel },
  { key: 'export_summary',           section: 'growth',  title: 'Downloads & shares',               params: [...RANGE, 'granularity'],  handler: exportSummary },
  { key: 'catalog_coverage',         section: 'content', title: 'Catalogue coverage gaps',          params: ['min', 'limit'],           handler: catalogCoverage },
  { key: 'events_without_templates', section: 'content', title: 'Upcoming events lacking designs',  params: ['days', 'min'],            handler: eventsWithoutTemplates },
  { key: 'pending_industries',       section: 'todo',    title: 'Industry suggestions to review',   params: ['limit'],                  handler: pendingIndustries },
  { key: 'recent_feedback',          section: 'todo',    title: 'Recent feedback',                  params: RANGE,                      handler: recentFeedback },
  { key: 'draft_templates',          section: 'todo',    title: 'Draft designs',                    params: ['limit'],                  handler: draftTemplates },
  { key: 'migration_status',         section: 'system',  title: 'Database migrations',              params: [],                         handler: migrationStatus },
].map((w) => ({ ...w, permission: `dashboard.${w.key}` }));

const BY_KEY = new Map(WIDGETS.map((w) => [w.key, w]));

// Dashboards get refreshed by several admins at once and several of these are
// full-table aggregates, so results are held briefly. Per process, which is fine:
// a stale-by-a-minute number on a dashboard is not a correctness problem, and
// `fresh=1` is there for the moment someone needs it to be now.
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX    = 500;
const cache = new Map();

function cacheKey(widget, query) {
  const picked = Object.fromEntries(widget.params.filter((p) => query[p] !== undefined).sort().map((p) => [p, String(query[p])]));
  return `${widget.key}:${JSON.stringify(picked)}`;
}

function manifest(permissions) {
  const widgets = WIDGETS
    .filter((w) => hasPermission(permissions, w.permission))
    .map(({ key, section, title, params, permission }) => ({ key, section, title, params, permission, endpoint: `/admin/dashboard/widgets/${key}` }));
  const used = new Set(widgets.map((w) => w.section));
  return { sections: SECTIONS.filter((s) => used.has(s.key)), widgets };
}

// Throws NotFoundError for an unknown key; the caller has already checked the
// permission (an unknown key is reported before the permission so a typo in the
// admin panel reads as a typo, not as a missing grant).
function getWidget(key) {
  const widget = BY_KEY.get(key);
  if (!widget) throw new NotFoundError(`Unknown dashboard widget: ${key}`);
  return widget;
}

async function runWidget(widget, query = {}) {
  const fresh = query.fresh === '1' || query.fresh === 'true';
  const key = cacheKey(widget, query);
  const hit = cache.get(key);
  if (!fresh && hit && hit.expires > Date.now()) return { data: hit.data, generated_at: hit.generated_at, cached: true };

  const data = await widget.handler(query);
  const generated_at = new Date().toISOString();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);   // oldest insertion
  cache.set(key, { data, generated_at, expires: Date.now() + CACHE_TTL_MS });
  return { data, generated_at, cached: false };
}

module.exports = {
  WIDGETS, SECTIONS, manifest, getWidget, runWidget,
  // exported for tests
  resolveRange, bucketOf, renewalOutcome, _clearCache: () => cache.clear(),
};
