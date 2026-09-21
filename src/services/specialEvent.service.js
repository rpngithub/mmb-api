const { Op } = require('sequelize');
const { SpecialEvent, Template } = require('../models');
const { ValidationError } = require('../errors');
const { SPECIAL_EVENT_TYPES } = require('../constants/specialEventTypes');

const MAX_WINDOW_DAYS = 366; // guard against unbounded ranges
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isPaidViewer = (viewer) => viewer?.tier === 'paid';

const todayISO = () => new Date().toISOString().slice(0, 10);
const addDaysISO = (iso, days) =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);

// Enumerate every calendar date in [from, to] inclusive (UTC, capped).
function enumerateDates(from, to) {
  const out = [];
  let cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end && out.length <= MAX_WINDOW_DAYS) {
    out.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 86400000);
  }
  return out;
}

// Resolve the requested window. Priority: explicit from/to > range shortcut >
// default (this week). `range=month` = the calendar month containing today;
// `range=year` = the rolling next 365 days, which is the "browse a type"
// window: every recurring event lands exactly once and upcoming one-offs
// come along, so `?type=festival&range=year` is the full festival list in
// upcoming order.
function resolveWindow({ from, to, range } = {}) {
  if (from || to) {
    const f = from || todayISO();
    const t = to   || addDaysISO(f, 6);
    if (!DATE_RE.test(f) || !DATE_RE.test(t)) throw new ValidationError('from/to must be YYYY-MM-DD');
    if (f > t) throw new ValidationError('from must be on or before to');
    return { from: f, to: t };
  }
  const base = todayISO();
  if (range === 'month') {
    const first = `${base.slice(0, 7)}-01`;
    const d = new Date(`${first}T00:00:00Z`);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    return { from: first, to: last };
  }
  if (range === 'year') return { from: base, to: addDaysISO(base, 364) };
  return { from: base, to: addDaysISO(base, 6) }; // default: this week (rolling 7 days)
}

// `?type=festival` or `?type=festival,holiday`. Unknown values are a 400 rather
// than a silent empty list, so a stale FE constant shows up in development.
function resolveTypes(type) {
  if (type === undefined || type === '') return null;
  const types = [...new Set(String(type).split(',').map((t) => t.trim()).filter(Boolean))];
  const bad = types.filter((t) => !SPECIAL_EVENT_TYPES.includes(t));
  if (bad.length) throw new ValidationError(`unknown type: ${bad.join(', ')} (expected one of ${SPECIAL_EVENT_TYPES.join(', ')})`);
  return types.length ? types : null;
}

async function listSpecialEvents(query = {}, viewer = null) {
  const { from, to } = resolveWindow(query);
  const types = resolveTypes(query.type);
  const dates   = enumerateDates(from, to);
  const mmddSet = [...new Set(dates.map((d) => d.slice(5)))];           // ["06-14", ...]
  const mmddToDate = new Map();                                         // "06-14" -> "2026-06-14"
  for (const d of dates) if (!mmddToDate.has(d.slice(5))) mmddToDate.set(d.slice(5), d);

  const rows = await SpecialEvent.findAll({
    where: {
      is_active: 1,
      ...(types ? { type: { [Op.in]: types } } : {}),
      [Op.or]: [
        { event_date: { [Op.in]: mmddSet } },          // recurring annual (MM-DD)
        { full_date:  { [Op.between]: [from, to] } },   // one-off concrete date
      ],
    },
    include: [{
      model: Template,
      through: { attributes: [] },
      required: false,
      where: { status: 'active' },
      attributes: { exclude: ['content'] },             // browse view: no editable content
    }],
  });

  const paid = isPaidViewer(viewer);
  const events = rows.map((row) => {
    const e = row.toJSON();
    // Concrete date this event falls on within the window (for per-day grouping).
    e.occurs_on = (e.event_date && mmddToDate.get(e.event_date))
      || (e.full_date && e.full_date >= from && e.full_date <= to ? e.full_date : null);
    e.Templates = (e.Templates || []).map((t) => ({ ...t, is_locked: Boolean(t.is_premium) && !paid }));
    return e;
  }).filter((e) => e.occurs_on); // every surfaced event must map to a day in the window

  // Order by the day they occur in this window, then name.
  events.sort((a, b) =>
    String(a.occurs_on).localeCompare(String(b.occurs_on)) || a.name.localeCompare(b.name));

  return { range: { from, to }, types, events };
}

module.exports = { listSpecialEvents };
