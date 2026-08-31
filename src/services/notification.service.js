const { Op, UniqueConstraintError } = require('sequelize');
const {
  NotificationTemplate, NotificationCategory, UserNotification, UserNotificationSetting,
} = require('../models');
const repo     = require('../repositories/notification.repository');
const render   = require('../utils/renderTemplate');
const istTime  = require('../utils/istTime');
const cfg      = require('../config/notifications');
const { NotFoundError, ForbiddenError } = require('../errors');

// The send path. Everything that creates an inbox row goes through here — event
// call sites, the scan jobs, and campaign fan-out alike — so the audience,
// consent, fatigue and dedupe rules cannot be bypassed or reimplemented slightly
// differently in three places.
//
// The single-send and batch paths share one gate: `dispatch()` is `dispatchBulk()`
// with an array of one. The batch path is what defines the query cost — two
// aggregate queries per CHUNK rather than per user.

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

// Why a send was skipped. Returned rather than thrown: a skip is the normal,
// expected outcome for most candidates in a scan, and exceptions would make the
// logs unreadable and the counts wrong.
const SKIP = {
  TEMPLATE_INACTIVE: 'template_inactive',
  NO_SUCH_USER:      'no_such_user',
  AUDIENCE_MISMATCH: 'audience_mismatch',
  MARKETING_OPT_OUT: 'marketing_opt_out',
  CATEGORY_MUTED:    'category_muted',
  DAILY_CAP:         'daily_cap',
  WEEKLY_CAP:        'weekly_cap',
  MIN_GAP:           'min_gap',
  COOLDOWN:          'cooldown',
  MAX_OCCURRENCES:   'max_occurrences',
  RENDER_FAILED:     'render_failed',
  DUPLICATE:         'duplicate',
};

// ---------------------------------------------------------------------------
// Template lookup
// ---------------------------------------------------------------------------

// The catalogue is ~43 rows, read on every dispatch and never during a request
// that also writes it. A short TTL keeps the scans from re-reading the same row
// hundreds of times per tick while still picking up an admin's copy edit within a
// minute — short enough that nobody has to think about cache invalidation.
const TEMPLATE_TTL_MS = 60 * 1000;
let templateCache = new Map();

function _cacheGet(code) {
  const hit = templateCache.get(code);
  if (hit && Date.now() - hit.at < TEMPLATE_TTL_MS) return hit.row;
  return undefined;
}

async function getTemplate(code) {
  const cached = _cacheGet(code);
  if (cached !== undefined) return cached;

  const row = await NotificationTemplate.findOne({ where: { code } });
  templateCache.set(code, { row, at: Date.now() });
  return row;
}

// Called by the admin CRUD after any template write, so an edit is visible at once
// rather than up to a minute later.
const invalidateTemplateCache = () => { templateCache = new Map(); };

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

// Does this user match who the template is for?
function _audienceOk(tpl, facts) {
  if (tpl.audience_account_type !== 'all' && facts.account_type !== tpl.audience_account_type) {
    return false;
  }
  switch (tpl.audience_plan) {
    case 'free':  return !Number(facts.is_paid);
    case 'paid':  return Boolean(Number(facts.is_paid));
    case 'trial': return Boolean(Number(facts.is_trial));
    default:      return true;
  }
}

/**
 * Applies every gate to one candidate and says yes or why not.
 *
 * Transactional templates (is_promotional = 0) skip the consent check, both caps,
 * the min-gap and the cooldown. A payment receipt is not marketing: it must reach
 * someone who muted promotions, and it must not be silently dropped because they
 * already had three nudges this morning. They still respect an explicit category
 * mute, because that is the user asking directly.
 */
function _gate(tpl, facts, fatigue, history, now, bypassFatigue = false) {
  if (!facts) return SKIP.NO_SUCH_USER;
  if (!_audienceOk(tpl, facts)) return SKIP.AUDIENCE_MISMATCH;
  if (Number(facts.category_muted)) return SKIP.CATEGORY_MUTED;

  if (!tpl.is_promotional) return null;

  if (!Number(facts.notify_marketing)) return SKIP.MARKETING_OPT_OUT;

  // A campaign may deliberately bypass the FATIGUE rules — a pricing change or an
  // outage notice is worth interrupting for. It can never bypass the two consent
  // checks above: those are the user's decision, not a volume control.
  if (bypassFatigue) return null;

  if (Number(fatigue.day_count || 0)  >= cfg.maxPerDay())  return SKIP.DAILY_CAP;
  if (Number(fatigue.week_count || 0) >= cfg.maxPerWeek()) return SKIP.WEEKLY_CAP;

  // The one that actually stops "six notifications in one morning" — the caps
  // alone would happily allow all three at 09:00:01, because the scans all run
  // within a few minutes of each other.
  if (fatigue.last_at && now - new Date(fatigue.last_at).getTime() < cfg.minGapMinutes() * 60 * 1000) {
    return SKIP.MIN_GAP;
  }

  if (tpl.max_occurrences && Number(history.total || 0) >= tpl.max_occurrences) {
    return SKIP.MAX_OCCURRENCES;
  }
  if (tpl.cooldown_hours && history.last_at &&
      now - new Date(history.last_at).getTime() < tpl.cooldown_hours * HOUR) {
    return SKIP.COOLDOWN;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// Build the row that lands in the inbox: a rendered snapshot plus its provenance.
function _buildRow(tpl, userId, dedupeKey, variables, now, overrides = {}) {
  const rendered = render.render(
    { code: tpl.code, title: overrides.title || tpl.title, body: overrides.body || tpl.body,
      variable_defaults: tpl.variable_defaults },
    variables,
  );

  // Quiet hours apply to promotional notifications only. The row is inserted NOW
  // either way, with a future deliver_at when deferred, so a retry of the same
  // trigger collides on the dedupe key instead of queueing a second copy.
  const deliverAt = tpl.is_promotional ? istTime.nextDeliverableAt(now) : now;

  return {
    user_id:        userId,
    template_id:    tpl.id,
    campaign_id:    overrides.campaign_id || null,
    category_id:    overrides.category_id !== undefined ? overrides.category_id : tpl.category_id,
    dedupe_key:     dedupeKey,
    is_promotional: tpl.is_promotional,
    title:          rendered.title,
    body:           rendered.body,
    cta_label:      overrides.cta_label  !== undefined ? overrides.cta_label  : tpl.cta_label,
    cta_action:     overrides.cta_action !== undefined ? overrides.cta_action : tpl.cta_action,
    cta_params:     overrides.cta_params !== undefined ? overrides.cta_params : tpl.cta_params,
    image_s3_key:   overrides.image_s3_key !== undefined ? overrides.image_s3_key : tpl.image_s3_key,
    variables:      rendered.variables,
    priority:       tpl.display_priority || 'normal',
    is_dismissible: tpl.is_dismissible,
    status:         deliverAt.getTime() > now.getTime() ? 'scheduled' : 'delivered',
    deliver_at:     deliverAt,
    expires_at:     tpl.expires_after_days
      ? new Date(now.getTime() + tpl.expires_after_days * DAY)
      : null,
  };
}

/**
 * Sends one template to many users.
 *
 * @param {object}   opts
 * @param {string}   opts.code        template code
 * @param {number[]} opts.userIds
 * @param {Function|object} opts.variables  values for the `{{tokens}}`, or a
 *                                          (userId) => values function when they
 *                                          differ per user
 * @param {Function|string} opts.dedupeKey  the key, or a (userId, facts) => key
 * @param {object}   [opts.overrides]  campaign copy overriding the template's
 * @returns {Promise<{ inserted, skipped, reasons }>}
 */
async function dispatchBulk({ code, userIds, variables = {}, dedupeKey, overrides = {}, template = null }) {
  const now = new Date();
  const reasons = {};
  const bump = (r) => { reasons[r] = (reasons[r] || 0) + 1; };

  const ids = [...new Set(userIds.filter(Boolean).map(Number))];
  if (!ids.length) return { inserted: 0, skipped: 0, reasons };

  const tpl = template || await getTemplate(code);
  if (!tpl) throw new NotFoundError(`Notification template '${code}' does not exist`);
  if (!tpl.is_active) {
    return { inserted: 0, skipped: ids.length, reasons: { [SKIP.TEMPLATE_INACTIVE]: ids.length } };
  }

  const categoryId = overrides.category_id !== undefined ? overrides.category_id : tpl.category_id;
  const bypass     = Boolean(overrides.bypass_fatigue);

  // Set-wise reads for the whole batch, regardless of its size. The fatigue ones
  // are skipped outright when they cannot change the answer.
  const needFatigue = tpl.is_promotional && !bypass;
  const dayStart  = new Date(now.getTime() - DAY);
  const weekStart = new Date(now.getTime() - 7 * DAY);
  const [factRows, fatigueRows, historyRows] = await Promise.all([
    repo.eligibilityFacts(ids, categoryId),
    needFatigue ? repo.fatigueFacts(ids, dayStart, weekStart) : [],
    needFatigue && (tpl.cooldown_hours || tpl.max_occurrences)
      ? repo.templateHistory(ids, tpl.id) : [],
  ]);

  const factsBy   = new Map(factRows.map((r) => [Number(r.user_id), r]));
  const fatigueBy = new Map(fatigueRows.map((r) => [Number(r.user_id), r]));
  const historyBy = new Map(historyRows.map((r) => [Number(r.user_id), r]));

  const rows = [];
  for (const userId of ids) {
    const facts = factsBy.get(userId);
    const skip  = _gate(tpl, facts, fatigueBy.get(userId) || {}, historyBy.get(userId) || {}, now.getTime(), bypass);
    if (skip) { bump(skip); continue; }

    const values = typeof variables === 'function' ? variables(userId, facts) : variables;
    const dk     = typeof dedupeKey === 'function' ? dedupeKey(userId, facts) : dedupeKey;

    try {
      rows.push(_buildRow(tpl, userId, dk, values, now, overrides));
    } catch (err) {
      // A missing variable aborts THIS user only. Shipping a message with a hole
      // in it is worse than not sending, but one bad row must not fail the batch.
      console.error(`[notify] render failed for user ${userId} on '${tpl.code}': ${err.message}`);
      bump(SKIP.RENDER_FAILED);
    }
  }

  if (!rows.length) {
    return { inserted: 0, skipped: ids.length, reasons };
  }

  const pairs = rows.map((r) => ({ user_id: r.user_id, dedupe_key: r.dedupe_key }));

  // Counted BEFORE the insert. Afterwards there is no way to tell a row this batch
  // created from one that was already there — INSERT IGNORE reports nothing useful
  // on MySQL (ids come back null), and a `created_at >= now` filter is unsound
  // because DATETIME truncates the sub-second part downwards. See the repository.
  const alreadyThere = await repo.countExistingKeys(pairs);

  // ignoreDuplicates emits INSERT IGNORE: a row whose (user_id, dedupe_key) is
  // already taken is silently dropped. That is what makes a re-run of any scan, a
  // webhook retry, and a second app instance all harmless.
  await UserNotification.bulkCreate(rows, { ignoreDuplicates: true });

  const inserted = rows.length - alreadyThere;
  if (alreadyThere > 0) reasons[SKIP.DUPLICATE] = alreadyThere;

  return { inserted, skipped: ids.length - inserted, reasons };
}

/**
 * Sends one template to one user. Returns the created row, or null when a gate
 * skipped it or it was a duplicate.
 *
 * Unlike the batch path this returns the row itself, because event call sites
 * sometimes want to log or return it — which INSERT IGNORE cannot give us. So this
 * uses a plain create and catches the unique violation.
 */
async function dispatch({ code, userId, variables = {}, dedupeKey, overrides = {} }) {
  const now = new Date();
  const tpl = await getTemplate(code);
  if (!tpl) throw new NotFoundError(`Notification template '${code}' does not exist`);
  if (!tpl.is_active) return { created: null, skipped: SKIP.TEMPLATE_INACTIVE };

  const categoryId = overrides.category_id !== undefined ? overrides.category_id : tpl.category_id;
  const dayStart   = new Date(now.getTime() - DAY);
  const weekStart  = new Date(now.getTime() - 7 * DAY);

  const [factRows, fatigueRows, historyRows] = await Promise.all([
    repo.eligibilityFacts([userId], categoryId),
    tpl.is_promotional ? repo.fatigueFacts([userId], dayStart, weekStart) : [],
    tpl.is_promotional && (tpl.cooldown_hours || tpl.max_occurrences)
      ? repo.templateHistory([userId], tpl.id) : [],
  ]);

  const facts = factRows[0];
  const skip  = _gate(tpl, facts, fatigueRows[0] || {}, historyRows[0] || {}, now.getTime());
  if (skip) return { created: null, skipped: skip };

  let row;
  try {
    row = _buildRow(tpl, userId, dedupeKey, variables, now, overrides);
  } catch (err) {
    console.error(`[notify] render failed for user ${userId} on '${tpl.code}': ${err.message}`);
    return { created: null, skipped: SKIP.RENDER_FAILED };
  }

  try {
    return { created: await UserNotification.create(row), skipped: null };
  } catch (err) {
    // Already told them about this occasion — a webhook retry, a double-submit, or
    // another instance getting there first.
    if (err instanceof UniqueConstraintError) return { created: null, skipped: SKIP.DUPLICATE };
    throw err;
  }
}

/**
 * Fire-and-forget wrapper for event call sites.
 *
 * A notification must NEVER break the request that triggered it: failing a
 * payment webhook because the inbox insert deadlocked would turn a cosmetic
 * problem into a billing one. Same discipline as activity.service#log.
 */
function notify(opts) {
  return dispatch(opts).catch((err) => {
    console.error(`[notify] '${opts.code}' failed for user ${opts.userId}: ${err.message}`);
    return { created: null, skipped: 'error' };
  });
}

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 50;

// What the user is allowed to see right now. Three exclusions, all of which have
// to be in the WHERE rather than filtered afterwards, or the page counts lie:
//   - `scheduled` rows are held back by quiet hours and not yet theirs to read
//   - dismissed rows are gone from the list (but kept, until the retention job)
//   - expired rows are stale — a festival reminder is noise a week later
function _visibleWhere(userId, now = new Date()) {
  return {
    user_id:    userId,
    status:     'delivered',
    deliver_at: { [Op.lte]: now },
    dismissed_at: null,
    [Op.or]: [{ expires_at: null }, { expires_at: { [Op.gt]: now } }],
  };
}

// The shape the app gets. `template_id` and the raw s3 key stay server-side —
// the first is an internal join, and image URLs are resolved the same way the rest
// of the API does it.
const _shape = (row) => ({
  uid:          row.uid,
  title:        row.title,
  body:         row.body,
  cta_label:    row.cta_label,
  cta_action:   row.cta_action,
  cta_params:   row.cta_params || null,
  image_s3_key: row.image_s3_key,
  priority:     row.priority,
  is_dismissible: Boolean(row.is_dismissible),
  is_read:      Boolean(row.read_at),
  read_at:      row.read_at,
  created_at:   row.created_at,
  category: row.NotificationCategory
    ? { uid: row.NotificationCategory.uid, name: row.NotificationCategory.name, slug: row.NotificationCategory.slug }
    : null,
});

async function listInbox(userId, filters = {}) {
  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);
  const where  = _visibleWhere(userId);

  if (filters.status === 'unread') where.read_at = null;

  if (filters.category) {
    const cat = await NotificationCategory.findOne({
      where: { [Op.or]: [{ slug: filters.category }, { uid: filters.category }] },
    });
    // An unknown category is an empty page, not a 404: the filter is a view, and
    // a category that was deleted should not break the user's inbox.
    if (!cat) return { rows: [], count: 0 };
    where.category_id = cat.id;
  }

  const { rows, count } = await UserNotification.findAndCountAll({
    where,
    include: [{ model: NotificationCategory, attributes: ['uid', 'name', 'slug'], required: false }],
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
  });

  return { rows: rows.map(_shape), count };
}

/**
 * The badge. Polled far more often than the list is opened, so it is deliberately
 * two cheap aggregates over ix_user_notif_inbox rather than a fetch-and-count.
 */
async function summary(userId) {
  const where = { ..._visibleWhere(userId), read_at: null };

  const [total, byCategory] = await Promise.all([
    UserNotification.count({ where }),
    UserNotification.findAll({
      where,
      attributes: ['category_id', [UserNotification.sequelize.fn('COUNT', '*'), 'count']],
      include: [{ model: NotificationCategory, attributes: ['uid', 'name', 'slug'], required: false }],
      group: ['category_id', 'NotificationCategory.id'],
      raw: true,
      nest: true,
    }),
  ]);

  return {
    unread_count: total,
    by_category: byCategory.map((r) => ({
      uid:   r.NotificationCategory?.uid || null,
      name:  r.NotificationCategory?.name || null,
      slug:  r.NotificationCategory?.slug || null,
      count: Number(r.count),
    })),
  };
}

// Scoped to the caller's own rows, so a guessed uid from another account is a 404
// rather than a cross-account write.
async function _ownRow(userId, uid) {
  const row = await UserNotification.findOne({ where: { uid, user_id: userId } });
  if (!row) throw new NotFoundError('Notification not found');
  return row;
}

async function markRead(userId, uid) {
  const row = await _ownRow(userId, uid);
  // Idempotent, and it keeps the ORIGINAL timestamp — re-reading something does
  // not make it newly read, and analytics on time-to-read would be wrong if it did.
  if (!row.read_at) await row.update({ read_at: istTime.nowSecond() });
  return _shape(row);
}

async function markAllRead(userId) {
  const [updated] = await UserNotification.update(
    { read_at: istTime.nowSecond() },
    { where: { ..._visibleWhere(userId), read_at: null } },
  );
  return { updated };
}

async function dismiss(userId, uid) {
  const row = await _ownRow(userId, uid);
  if (!row.is_dismissible) throw new ForbiddenError('This notification cannot be dismissed');
  // Soft. The row stays for the fatigue counters and for "did we tell them?", and
  // the retention job is the only thing that ever deletes.
  const now = istTime.nowSecond();
  if (!row.dismissed_at) await row.update({ dismissed_at: now, read_at: row.read_at || now });
  return { uid: row.uid, dismissed_at: row.dismissed_at };
}

async function dismissAll(userId) {
  const now = istTime.nowSecond();
  const [updated] = await UserNotification.update(
    { dismissed_at: now },
    { where: { ..._visibleWhere(userId), is_dismissible: 1 } },
  );
  return { updated };
}

// ---------------------------------------------------------------------------
// Per-category mute
// ---------------------------------------------------------------------------

/**
 * Every active category with the user's current choice.
 *
 * A settings row exists only where someone turned something OFF, so this LEFT
 * JOINs and defaults to on — the same lazy convention user.service#getPreferences
 * uses, which is why enabling this feature needed no backfill.
 */
async function getSettings(userId) {
  const [categories, chosen] = await Promise.all([
    NotificationCategory.findAll({
      where: { is_active: 1 },
      order: [['display_order', 'ASC'], ['name', 'ASC']],
    }),
    UserNotificationSetting.findAll({ where: { user_id: userId } }),
  ]);

  const byCat = new Map(chosen.map((s) => [s.category_id, s]));
  return categories.map((c) => ({
    uid:         c.uid,
    name:        c.name,
    slug:        c.slug,
    description: c.description,
    icon:        c.icon,
    in_app:      byCat.has(c.id) ? Boolean(byCat.get(c.id).in_app) : true,
  }));
}

async function updateSettings(userId, items) {
  for (const item of items) {
    const cat = await NotificationCategory.findOne({ where: { uid: item.category_uid } });
    if (!cat) throw new NotFoundError(`Unknown notification category '${item.category_uid}'`);

    const existing = await UserNotificationSetting.findOne({
      where: { user_id: userId, category_id: cat.id },
    });
    if (existing) await existing.update({ in_app: item.in_app ? 1 : 0 });
    else await UserNotificationSetting.create({ user_id: userId, category_id: cat.id, in_app: item.in_app ? 1 : 0 });
  }
  return getSettings(userId);
}

module.exports = {
  dispatch,
  dispatchBulk,
  notify,
  getTemplate,
  invalidateTemplateCache,
  SKIP,
  // inbox
  listInbox,
  summary,
  markRead,
  markAllRead,
  dismiss,
  dismissAll,
  getSettings,
  updateSettings,
  // exported for the admin preview and tests
  _gate,
  _buildRow,
  _visibleWhere,
};
