// Deployment knobs for the notification engine.
//
// Read from process.env on each call rather than captured at require time, so a
// test can flip one without re-requiring the module — the same approach as
// config/quota.js.

const int = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

// The kill switch. `NOTIFY_JOBS_ENABLED=false` stops every scan and the campaign
// dispatcher from doing any work, without a deploy and without touching the API.
// Sends triggered directly by an event still go through — those are transactional
// and stopping them would break receipts, not spam.
const jobsEnabled = () => process.env.NOTIFY_JOBS_ENABLED !== 'false';

// Per-user fatigue ceilings. Promotional notifications only: transactional sends
// are neither capped nor counted, so a run of payment receipts can never crowd out
// a nudge (or vice versa).
const maxPerDay  = () => int('NOTIFY_MAX_PER_DAY', 3);
const maxPerWeek = () => int('NOTIFY_MAX_PER_WEEK', 10);

// The one that actually prevents "six notifications in one morning". A daily cap
// of 3 still permits all three at 09:00:01, because the nightly scans all run
// within a few minutes of each other — the gap is what spaces them out.
const minGapMinutes = () => int('NOTIFY_MIN_GAP_MINUTES', 45);

// Quiet hours in IST, [start, end) on a 24h clock. Nothing promotional is
// delivered between 21:00 and 09:00; a send decided inside the window is inserted
// immediately with a deferred deliver_at (see userNotification.model.js) so a
// retry cannot queue a second copy.
const quietStartHour = () => int('NOTIFY_QUIET_START_HOUR', 21);
const quietEndHour   = () => int('NOTIFY_QUIET_END_HOUR', 9);

// India-only product — otpHelper.toLocalNumber enforces Indian 10-digit numbers,
// and `users` has no timezone column on purpose. IST has no DST, so this is a
// constant offset and not something Intl needs to be consulted about per row.
// Revisit the whole quiet-hours model, not just this number, if MMB goes
// multi-region.
const tzOffsetMinutes = () => int('NOTIFY_TZ_OFFSET_MINUTES', 330);

// Retention for user_notifications, by state. Nothing is DERIVED from these rows
// except the fatigue counts, which look back at most 7 days, and `max_occurrences`
// — whose semantics are therefore "within the retention window", which is the
// documented behaviour rather than a bug.
const retentionDismissedDays    = () => int('NOTIFY_RETENTION_DISMISSED_DAYS', 30);
const retentionReadDays         = () => int('NOTIFY_RETENTION_READ_DAYS', 90);
const retentionUnreadDays       = () => int('NOTIFY_RETENTION_UNREAD_DAYS', 180);

// Batch sizes. 500 keeps one multi-row INSERT near a single network packet; the
// per-run ceiling makes a runaway scan loud and bounded rather than fatal.
const batchSize     = () => int('NOTIFY_BATCH_SIZE', 500);
const maxRowsPerRun = () => int('NOTIFY_MAX_ROWS_PER_RUN', 50000);

module.exports = {
  jobsEnabled,
  maxPerDay,
  maxPerWeek,
  minGapMinutes,
  quietStartHour,
  quietEndHour,
  tzOffsetMinutes,
  retentionDismissedDays,
  retentionReadDays,
  retentionUnreadDays,
  batchSize,
  maxRowsPerRun,
};
