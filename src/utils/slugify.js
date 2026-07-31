// Deterministic name -> URL slug. Lowercases, strips accents, and collapses any
// run of non-alphanumeric characters to a single hyphen (trimmed at the ends).
// Used both by the slug backfill migration and by adminCrud's auto-slug on create,
// so the two MUST agree — keep this the single source of truth.
//
//   "Restaurant & Food"  -> "restaurant-food"
//   "YouTube Thumbnails" -> "youtube-thumbnails"
//   "1080x1080"          -> "1080x1080"
//
// Capped at 120 chars to match the DB column. Returns '' for input that has no
// sluggable characters (callers fall back to a synthetic slug, e.g. `item-<id>`).
function slugify(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop combining accent marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')     // any non-alphanumeric run -> single hyphen
    .replace(/^-+|-+$/g, '')         // trim leading/trailing hyphens
    .slice(0, 120)
    .replace(/-+$/g, '');            // re-trim if the slice landed on a hyphen
}

module.exports = slugify;
