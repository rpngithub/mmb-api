const { ValidationError } = require('../errors');

// Publish checklist for a quota pack, the top-up counterpart of framePublish.js.
//
// A pack may only reach `active` once buying it would actually do something:
//   - a name, because the store card has to say what is being sold,
//   - a feature that is marked top-uppable, so the grant lands somewhere a meter
//     will ever read,
//   - a quantity above zero — a pack that grants nothing is money for nothing,
//   - a price above zero. Free quota is an admin GRANT, not a store listing; a
//     ₹0 pack would send the buyer through Razorpay for a zero-rupee order.
//
// Unlike a frame there is no content or thumbnail to wait on, so unlike frames a
// pack CAN be created complete in a single call.

// The checklist evaluated over lightweight SIGNALS rather than a row, so the admin
// list can report readiness per row using only what it already selected. Both
// callers below funnel through here so the gate and the list can never drift.
function missingFromSignals({ name, feature_type_id, is_topupable, quantity, price }) {
  const missing = [];
  const need = (ok, field, message) => { if (!ok) missing.push({ field, message }); };

  need(String(name || '').trim(), 'name',            'Name is required');
  need(feature_type_id,           'feature_type_id', 'A feature type is required');
  // Guards the case that makes a pack useless rather than merely incomplete:
  // quota sold for a feature nothing is allowed to top up can never be spent.
  need(is_topupable,              'feature_type_id', 'This feature is not enabled for top-ups');
  need(Number(quantity) > 0,      'quantity',        'Quantity must be above zero');
  need(Number(price) > 0,         'price',           'A pack needs a price above zero');

  return missing;
}

function missingForPublish(row, patch = {}, featureType = null) {
  // Judge the state the row WOULD have after this write, so a request that sets
  // quantity and status together is not tested against the pre-update value.
  const next = { ...(row ? row.toJSON() : {}), ...patch };

  // `is_topupable` lives on the feature type, not on the pack. Prefer an
  // explicitly supplied one (the write may be REPOINTING the pack at a different
  // feature) and fall back to whatever the row was loaded with.
  const ft = featureType || row?.FeatureType || null;

  return missingFromSignals({ ...next, is_topupable: ft ? Number(ft.is_topupable) === 1 : false });
}

/**
 * Reject a write that would publish an incomplete pack (400 VALIDATION_ERROR with
 * one `details` entry per unmet requirement, keyed by field).
 *
 * Only the TRANSITION into `active` is guarded. UNPUBLISHING — back to draft or
 * inactive — is always allowed, including for a pack that would no longer pass
 * the checklist, and it is NOT a clawback: everyone who already bought the pack
 * keeps their balance, exactly as frame owners keep an unpublished frame.
 *
 * @param {Model|null} row          the pack being updated, or null on create
 * @param {object}     patch        the incoming payload
 * @param {Model|null} featureType  the feature type the write points at, when known
 */
function assertPublishable(row, patch = {}, featureType = null) {
  if (patch.status !== 'active') return;
  if (row && row.status === 'active') return;

  const missing = missingForPublish(row, patch, featureType);
  if (missing.length) throw new ValidationError('Quota pack is not ready to publish', missing);
}

module.exports = { missingFromSignals, missingForPublish, assertPublishable };
