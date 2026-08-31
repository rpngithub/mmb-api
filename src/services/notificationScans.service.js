const { NotificationTemplate } = require('../models');
const scans   = require('../repositories/notificationScans.repository');
const notify  = require('./notification.service');
const dedupe  = require('../utils/dedupeKey');
const istTime = require('../utils/istTime');
const cfg     = require('../config/notifications');

// The scan drivers: for each active template of a given trigger type, find the
// users who currently match it and dispatch.
//
// Templates are walked in DESCENDING priority within a tick, so when a user's
// daily cap bites it is spent on the most valuable message rather than on whichever
// scan happened to run first. That ordering is the entire arbitration mechanism —
// no scoring engine, just an ORDER BY over ~43 rows.

const DAY_MS = 86400000;

async function _activeTemplates(triggerType) {
  return NotificationTemplate.findAll({
    where: { trigger_type: triggerType, is_active: 1 },
    order: [['priority', 'DESC'], ['id', 'ASC']],
  });
}

/**
 * Pages through a scan query, dispatching each page.
 *
 * `cursorField` matters: each query pages on the column it ORDERs by, which is not
 * always `user_id` — the subscription scan pages on `subscription_id`, and taking
 * the user id there would produce a cursor from a different sequence entirely and
 * either skip rows or loop.
 */
async function _drain(fetchPage, buildBatch, cursorField = 'user_id') {
  const limit = cfg.batchSize();
  const cap   = cfg.maxRowsPerRun();
  let cursor = 0;
  let scanned = 0;
  let inserted = 0;
  let skipped = 0;

  for (;;) {
    const rows = await fetchPage(cursor, limit);
    if (!rows.length) break;

    scanned += rows.length;
    const result = await buildBatch(rows);
    inserted += result.inserted;
    skipped  += result.skipped;

    cursor = Number(rows[rows.length - 1][cursorField]);
    if (rows.length < limit) break;
    if (scanned >= cap) {
      // Loud and bounded rather than fatal. The remainder is picked up by the next
      // run, still inside its scan window.
      console.warn(`[Notify] scan hit the ${cap}-row ceiling; the remainder rolls into the next run`);
      break;
    }
  }

  return { scanned, inserted, skipped };
}

// Per-user lookups happen once per row in a 500-row batch; a linear find() would
// make that quadratic.
const byUser = (rows) => new Map(rows.map((r) => [Number(r.user_id), r]));

// ---------------------------------------------------------------------------
// Behavioural
// ---------------------------------------------------------------------------

// Maps a template's trigger_config.predicate to the query that finds candidates
// and the dedupe key that makes it fire once per episode.
const PREDICATES = {
  inactive: (tpl, c) => ({
    fetch: (cursor, limit) => scans.inactive({ days: c.days, windowDays: c.window_days, cursor, limit }),
    // DATE(last_active_at): frozen while they stay away, jumps when they return.
    key:   (row) => dedupe.forDormancy(tpl.code, row.anchor),
  }),
  never_returned: (tpl, c) => ({
    fetch: (cursor, limit) => scans.neverReturned({ days: c.days, windowDays: c.window_days, cursor, limit }),
    key:   (row) => dedupe.key(tpl.code, 'signup', row.anchor),
  }),
  onboarding_incomplete: (tpl, c) => ({
    fetch: (cursor, limit) => scans.onboardingIncomplete({ minDays: c.min_days, maxDays: c.max_days, cursor, limit }),
    // Cycle bucket over signup age, so the nag repeats weekly rather than once —
    // bounded by the template's max_occurrences.
    key:   (row) => dedupe.forCycle(tpl.code, row.anchor, 7),
  }),
  no_projects: (tpl, c) => ({
    fetch: (cursor, limit) => scans.noProjects({ minDays: c.min_days, maxDays: c.max_days, cursor, limit }),
    key:   (row) => dedupe.forCycle(tpl.code, row.anchor, 7),
  }),
  no_business_profile: (tpl, c) => ({
    fetch: (cursor, limit) => scans.noBusinessProfile({ minDays: c.min_days, maxDays: c.max_days, cursor, limit }),
    key:   (row) => dedupe.forCycle(tpl.code, row.anchor, 14),
  }),
  still_personal: (tpl, c) => ({
    fetch: (cursor, limit) => scans.stillPersonal({ minDays: c.cycle_days, cursor, limit }),
    key:   (row) => dedupe.forCycle(tpl.code, row.anchor, c.cycle_days || 12),
  }),
};

// The five business setup gaps share one shape: nag again every 14 days, because
// the owner may well add a logo three weeks later.
for (const gap of Object.keys(scans.BUSINESS_GAPS)) {
  PREDICATES[gap] = (tpl, c) => ({
    fetch: (cursor, limit) => scans.businessGap({
      gap, minDays: c.min_days || 1, maxDays: c.max_days || (c.window_days || 3) + 1, cursor, limit,
    }),
    key: (row) => dedupe.key(tpl.code, 'biz', row.business_id,
      `c${Math.floor(Math.max(0, istTime.istDaysBetween(row.anchor)) / 14)}`),
  });
}

async function runBehavioral() {
  const templates = await _activeTemplates('behavioral');
  let scanned = 0;
  let inserted = 0;
  let skipped = 0;

  for (const tpl of templates) {
    const config  = tpl.trigger_config || {};
    const factory = PREDICATES[config.predicate];
    if (!factory) {
      // A template whose predicate nothing implements would otherwise be a silent
      // no-op forever — exactly the failure mode this feature must not have.
      console.warn(`[Notify:behavioral] '${tpl.code}' has no predicate for '${config.predicate}' — skipped`);
      continue;
    }

    const { fetch, key } = factory(tpl, config);
    const r = await _drain(fetch, (rows) => {
      const index = byUser(rows);
      return notify.dispatchBulk({
        code: tpl.code,
        template: tpl,
        userIds: [...index.keys()],
        dedupeKey: (userId) => key(index.get(userId)),
      });
    });

    scanned += r.scanned; inserted += r.inserted; skipped += r.skipped;
  }

  return { scanned, inserted, skipped };
}

// ---------------------------------------------------------------------------
// Date-anchored
// ---------------------------------------------------------------------------

/**
 * The calendar date whose events this template is about.
 *
 * `offset_days` is stated from the USER's point of view — "-1" means "tell them
 * one day BEFORE it happens" — so the event we are looking for is that many days
 * in the FUTURE. Hence minus, not plus: offset -1 on the 8th targets the 9th.
 */
const eventDateFor = (offsetDays, now) =>
  istTime.istDateISO(new Date(now.getTime() - (offsetDays || 0) * DAY_MS));

async function runScheduled(now = new Date()) {
  const templates = await _activeTemplates('scheduled');
  let scanned = 0;
  let inserted = 0;
  let skipped = 0;

  for (const tpl of templates) {
    const c = tpl.trigger_config || {};
    let r = { scanned: 0, inserted: 0, skipped: 0 };

    if (c.anchor === 'trial_end' || c.anchor === 'subscription_end') {
      const subType = c.anchor === 'trial_end' ? 'trial' : 'regular';
      const offset  = Math.abs(c.offset_days || 1);

      r = await _drain(
        (cursor, limit) => scans.subscriptionsEnding({ offsetDays: offset, subType, cursor, limit }),
        (rows) => {
          const index = byUser(rows);
          return notify.dispatchBulk({
            code: tpl.code,
            template: tpl,
            userIds: [...index.keys()],
            // The subscription AND its end date, so a renewal that moves ends_at
            // earns a fresh warning next term instead of being suppressed by the
            // one sent for the previous term.
            dedupeKey: (userId) => {
              const row = index.get(userId);
              return dedupe.key(tpl.code, 'sub', row.subscription_id, row.anchor);
            },
            variables: (userId) => ({
              plan_name:  index.get(userId).plan_name || 'Premium',
              days_count: offset,
            }),
          });
        },
        // This query ORDERs by s.id, so that is what the cursor must follow.
        'subscription_id',
      );
    } else if (c.anchor === 'special_event') {
      const targetDate = eventDateFor(c.offset_days, now);
      const events = await scans.eventsOn({ dateISO: targetDate, types: c.event_types || null });

      for (const ev of events) {
        const one = await _drain(
          (cursor, limit) => scans.activeUsers({
            accountType: tpl.audience_account_type === 'all' ? null : tpl.audience_account_type,
            cursor, limit,
          }),
          (rows) => notify.dispatchBulk({
            code: tpl.code,
            template: tpl,
            userIds: rows.map((x) => Number(x.user_id)),
            // Event id AND the concrete date, so an annually recurring festival
            // fires again next year rather than never again.
            dedupeKey: dedupe.key(tpl.code, 'ev', ev.event_id, targetDate),
            variables: { event_name: ev.event_name },
          }),
        );
        r.scanned += one.scanned; r.inserted += one.inserted; r.skipped += one.skipped;
      }
    }

    scanned += r.scanned; inserted += r.inserted; skipped += r.skipped;
  }

  return { scanned, inserted, skipped };
}

// ---------------------------------------------------------------------------
// Recurring
// ---------------------------------------------------------------------------

// Is today the day this template goes out? Evaluated per run rather than by
// registering a cron per template, so an admin changing a cadence takes effect
// immediately and no template can be left with an orphaned schedule.
function _dueToday(config, now) {
  const rec = config.recurrence;
  if (rec === 'weekly') {
    // 0 = Sunday. Read off the IST-shifted clock, not the server's timezone.
    const weekday = config.weekday !== undefined ? config.weekday : 1;
    const istDow  = new Date(`${istTime.istDateISO(now)}T00:00:00Z`).getUTCDay();
    return istDow === weekday;
  }
  // 'every_n_days' is evaluated daily on purpose: the template's cooldown_hours
  // and the cycle-bucket dedupe key are what actually space it out, so there is
  // nothing for a calendar check to add.
  return rec === 'every_n_days';
}

async function runRecurring(now = new Date()) {
  const templates = await _activeTemplates('recurring');
  let scanned = 0;
  let inserted = 0;
  let skipped = 0;

  for (const tpl of templates) {
    const c = tpl.trigger_config || {};
    if (!_dueToday(c, now)) continue;

    const dedupeKey = c.recurrence === 'weekly'
      ? dedupe.forWeek(tpl.code, now)
      : dedupe.key(tpl.code, `c${Math.floor(now.getTime() / ((c.days || 21) * DAY_MS))}`);

    const r = await _drain(
      (cursor, limit) => scans.activeUsers({
        accountType: tpl.audience_account_type === 'all' ? null : tpl.audience_account_type,
        cursor, limit,
      }),
      (rows) => notify.dispatchBulk({
        code: tpl.code,
        template: tpl,
        userIds: rows.map((x) => Number(x.user_id)),
        dedupeKey,
      }),
    );

    scanned += r.scanned; inserted += r.inserted; skipped += r.skipped;
  }

  return { scanned, inserted, skipped };
}

module.exports = { runBehavioral, runScheduled, runRecurring, PREDICATES, _dueToday, eventDateFor };
