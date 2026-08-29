const { ValidationError } = require('../errors');

// Publish checklist for a frame, the frames counterpart of templatePublish.js.
// A frame may only reach `active` once it can render and be found:
//   - a design payload (content) and a thumbnail for the store grid,
//   - a category — the store is browsed ONLY by chip, so an uncategorised frame
//     is unreachable (templates get a second anchor via industry; frames have none),
//   - a coherent price: premium means it costs something, free means it does not.
//
// Frame designs are SELF-CONTAINED (no referenced asset files, unlike a template
// bundle), so `content` arrives as a plain string on the write — there is no
// bundle-confirm step here. Create still cannot satisfy the checklist in one call
// in practice, because the thumbnail is uploaded against the uid create returns.

// The checklist evaluated over lightweight SIGNALS rather than a row, so the admin
// list can report readiness per row WITHOUT selecting the heavy `content` blob (it
// only ever needs to know whether content is non-empty, which SQL can answer).
// Both callers below funnel through here so the gate and the list can never drift.
function missingFromSignals({ name, category_id, has_content, has_thumbnail, is_premium, price }) {
  const missing = [];
  const need = (ok, field, message) => { if (!ok) missing.push({ field, message }); };

  const premium = Number(is_premium) === 1;
  const amount  = Number(price ?? 0);

  need(String(name || '').trim(), 'name',             'Name is required');
  need(category_id,               'category_id',      'A frame category is required');
  need(has_content,               'content',          'Design content has not been added');
  need(has_thumbnail,             'thumbnail_s3_key', 'Thumbnail is not set');
  // Both directions matter. A premium frame priced at 0 would be bought for
  // nothing; a free frame with a price set would display a price the store never
  // charges, because the free path skips checkout entirely.
  need(!premium || amount > 0,    'price',            'A premium frame needs a price above zero');
  need(premium  || amount === 0,  'price',            'A free frame cannot have a price');

  return missing;
}

function missingForPublish(row, patch = {}) {
  // Judge the state the row WOULD have after this write, so a request that sets
  // category_id and status together is not tested against the pre-update value.
  const next = { ...(row ? row.toJSON() : {}), ...patch };

  return missingFromSignals({
    ...next,
    has_content:   Boolean(String(next.content || '').trim()),
    has_thumbnail: Boolean(String(next.thumbnail_s3_key || '').trim()),
  });
}

/**
 * Reject a write that would publish an incomplete frame (400 VALIDATION_ERROR
 * with one `details` entry per unmet requirement, keyed by field).
 *
 * Only the TRANSITION into `active` is guarded. UNPUBLISHING — back to draft or
 * inactive — is always allowed, including for a frame that would no longer pass
 * the checklist; the gate is about publishing, not about trapping a row in the
 * store or retroactively invalidating rows that predate it.
 *
 * @param {Model|null} row    the frame being updated, or null on create
 * @param {object}     patch  the incoming payload
 */
function assertPublishable(row, patch = {}) {
  if (patch.status !== 'active') return;
  if (row && row.status === 'active') return;

  const missing = missingForPublish(row, patch);
  if (missing.length) throw new ValidationError('Frame is not ready to publish', missing);
}

module.exports = { missingFromSignals, missingForPublish, assertPublishable };
