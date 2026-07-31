const { ValidationError } = require('../errors');

// Server-side mirror of the admin panel's publish checklist (src/lib/templateCompleteness.js).
// A template may only reach `active` once it can actually render and be found:
//   - bundle uploaded (content) and a thumbnail chosen,
//   - a taxonomy anchor — category OR at least one industry (public browse is
//     anchored on exactly those two, so a template with neither is unreachable),
//   - at least one size and one tag.
// Create can never satisfy this: content/thumbnail are written by the bundle flow,
// which needs the uid that create returns. So a new template is always a draft.
async function missingForPublish(row, patch = {}) {
  // Evaluate the state the row WOULD have after this write, so a request that sets
  // category_id and status together isn't judged on the pre-update value.
  const next = { ...(row ? row.toJSON() : {}), ...patch };

  const [tags, sizes, industries] = row
    ? await Promise.all([row.countTags(), row.countTemplateSizes(), row.countBusinessCategories()])
    : [0, 0, 0];

  const missing = [];
  const need = (ok, field, message) => { if (!ok) missing.push({ field, message }); };

  need(String(next.name || '').trim(),             'name',             'Name is required');
  need(next.category_id || industries > 0,         'category_id',      'A template category or at least one industry is required');
  need(String(next.content || '').trim(),          'content',          'Bundle has not been uploaded');
  need(String(next.thumbnail_s3_key || '').trim(), 'thumbnail_s3_key', 'Thumbnail is not set');
  need(sizes > 0,                                  'size_ids',         'At least one size is required');
  need(tags > 0,                                   'tag_ids',          'At least one tag is required');

  return missing;
}

/**
 * Reject a write that would publish an incomplete template (400 VALIDATION_ERROR
 * with one `details` entry per unmet requirement, keyed by field).
 *
 * Only the TRANSITION into `active` is guarded — moving back to draft/inactive is
 * always allowed, and editing a row that is already active does not re-run the
 * check (the gate is about publishing, not about retroactively invalidating rows
 * that predate it).
 *
 * @param {Model|null} row    the template being updated, or null on create
 * @param {object}     patch  the incoming payload
 */
async function assertPublishable(row, patch = {}) {
  if (patch.status !== 'active') return;
  if (row && row.status === 'active') return;

  const missing = await missingForPublish(row, patch);
  if (missing.length) throw new ValidationError('Template is not ready to publish', missing);
}

module.exports = { missingForPublish, assertPublishable };
