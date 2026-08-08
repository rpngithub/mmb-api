// Resolves a *friendly* catalog reference — a slug, a uid (UUID), or a legacy
// integer id — to the model's internal integer primary key, so services can keep
// building the same id-based WHERE / EXISTS clauses they always have.
//
// This is what makes the public catalog params developer-friendly: a client can
// pass `?parent=restaurant-food` or `?category=youtube-thumbnails` without first
// fetching the parent list to learn a numeric id. Integer ids still work
// (backward compatible), and uids work as a stable non-guessable alternative.
//
// Return contract (kept deliberately small so callers can branch on it):
//   undefined  -> no reference supplied; caller should apply no filter
//   null       -> the literal 'null' (only meaningful for parent filters:
//                 "top-level", i.e. parent_id IS NULL)
//   0          -> a reference WAS supplied but matched nothing; caller should
//                 filter to the empty set (NOT ignore it — a bad slug must not
//                 silently widen the results)
//   <positive> -> the resolved integer id
const NOT_FOUND = 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_RE  = /^\d+$/;

// `hasUid` lets callers skip the UUID branch for models without a uid column
// (e.g. Tag): such a ref is only ever a slug or a legacy id.
// `field` names the human-readable column when the model does not call it `slug`
// (e.g. Language, whose friendly ref is its `code` — 'en', 'ta').
async function resolveRef(model, ref, { hasUid = true, field = 'slug' } = {}) {
  if (ref === undefined || ref === null) return undefined;
  const s = String(ref).trim();
  if (s === '') return undefined;
  if (s === 'null') return null;                 // explicit top-level parent
  if (INT_RE.test(s)) return Number(s);          // legacy integer id (accepted as-is)

  const where = hasUid && UUID_RE.test(s) ? { uid: s } : { [field]: s };
  const row   = await model.findOne({ where, attributes: ['id'] });
  return row ? row.id : NOT_FOUND;
}

// List form for multi-value filters (e.g. tags). Accepts "a,b,c", ["a","b"],
// or a single value; resolves each ref and returns a de-duped array of positive
// integer ids. Unresolved refs are dropped (a bad tag just narrows the match set
// by one — it should not empty the whole result the way a bad anchor does).
async function resolveRefList(model, refs, opts = {}) {
  if (refs === undefined || refs === null || refs === '') return [];
  const parts = Array.isArray(refs) ? refs : String(refs).split(',');
  const ids   = new Set();
  for (const part of parts) {
    const id = await resolveRef(model, part, opts);
    if (typeof id === 'number' && id > 0) ids.add(id);
  }
  return [...ids];
}

// Picks the caller-facing value: the first param that was actually supplied, in
// preference order. Lets an endpoint accept the friendly name, its legacy `*_id`
// form, and any renamed-away aliases at once while preferring the newest.
// e.g. pick(series, series_id, group, group_id)
const pick = (...values) => values.find((v) => v !== undefined && v !== '');

module.exports = { resolveRef, resolveRefList, pick, NOT_FOUND };
