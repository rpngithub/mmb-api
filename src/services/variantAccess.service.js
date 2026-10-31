const { Op } = require('sequelize');
const { Business, BusinessVariant, UserVariant, Template, VariantTemplate } = require('../models');
const userSubRepo = require('../repositories/userSubscription.repository');

// Central authority for premium-variant access. Gating sits on the VARIANT, not on its
// parent Brand Series. Every variant is SHOWN to everyone (guests included) as a teaser;
// USING one — its design content, opening a template, starting a project — takes one of:
//   1. PURCHASE — the viewer bought the variant outright (user_variants, active).
//      Permanent, with or without a subscription (see variantPurchase.service).
//   2. ADDED    — a business the viewer owns added the variant ("Add to your Business")
//      AND the viewer holds an active subscription. Adding is limited by the plan's
//      Brand Series quota (variantQuota.service); when the subscription lapses the
//      added variants pause, and come back on resubscribing.
// A subscription on its own unlocks nothing. The per-variant "allowed plans" list
// (variant_plan_restrictions) is no longer read anywhere: it dates from when the
// variant was hidden from everyone but its plans, and now that every variant is
// shown to everyone it has no job.
//
// The JWT only carries a coarse paid/free tier, so "is there an active subscription?"
// is a per-request DB lookup — a renewal must restore access immediately, not on
// token refresh.

const asArray = (v) => (Array.isArray(v) ? v : [v]);

// The viewer's active subscription plan id, or null (guest / no active sub).
async function activePlanId(viewer) {
  if (!viewer?.userId) return null;
  const sub = await userSubRepo.findActiveByUser(viewer.userId);
  return sub ? sub.plan_id : null;
}

// Variant ids, among `ids`, that a business owned by `userId` has added. Says nothing
// about whether they are usable right now — that also needs an active subscription.
async function addedVariantIds(userId, ids) {
  if (!userId || !ids.length) return new Set();
  const businesses = await Business.findAll({ where: { user_id: userId }, attributes: ['id'] });
  if (!businesses.length) return new Set();
  const rows = await BusinessVariant.findAll({
    where: { business_id: { [Op.in]: businesses.map((b) => b.id) }, variant_id: { [Op.in]: ids } },
    attributes: ['variant_id'],
  });
  return new Set(rows.map((r) => r.variant_id));
}

// Variant ids, among `ids`, the user bought. Pending checkouts grant nothing.
async function purchasedVariantIds(userId, ids) {
  if (!userId || !ids.length) return new Set();
  const rows = await UserVariant.findAll({
    where: { user_id: userId, variant_id: { [Op.in]: ids }, status: 'active' },
    attributes: ['variant_id'],
  });
  return new Set(rows.map((r) => r.variant_id));
}

// HOW the viewer reaches each of these variants: Map<variantId, 'purchased' | 'added'>;
// a variant they cannot use is absent. A purchase wins when both apply — it is the
// one that survives the subscription ending.
//
// Fixed query count (≤4) no matter how many variants are asked about, so the brand
// series list can report an unlocked tally without a per-variant round trip.
async function accessVia(variantIds, viewer) {
  const ids = [...new Set(asArray(variantIds))];
  const via = new Map();
  if (!ids.length || !viewer?.userId) return via;   // guests unlock nothing

  (await purchasedVariantIds(viewer.userId, ids)).forEach((id) => via.set(id, 'purchased'));

  const rest = ids.filter((id) => !via.has(id));
  if (rest.length && (await activePlanId(viewer))) {
    (await addedVariantIds(viewer.userId, rest)).forEach((id) => via.set(id, 'added'));
  }
  return via;
}

// Can the viewer use this variant's templates?
async function isVariantUnlocked(variantId, viewer) {
  return (await accessVia([variantId], viewer)).has(variantId);
}

// Bulk form of isVariantUnlocked: which of these variants can the viewer use?
async function unlockedVariantIds(variantIds, viewer) {
  return new Set((await accessVia(variantIds, viewer)).keys());
}

// Variant ids a design (template family) belongs to (empty = not a variant design).
// Membership is per family: every language and size of a design is in the variant.
async function familyVariantIds(familyId) {
  const rows = await VariantTemplate.findAll({ where: { family_id: familyId }, attributes: ['variant_id'] });
  return rows.map((r) => r.variant_id);
}

// Same, for one version (template row) — resolved through its family.
async function templateVariantIds(templateId) {
  const tpl = await Template.findByPk(templateId, { attributes: ['family_id'] });
  return tpl ? familyVariantIds(tpl.family_id) : [];
}

// Access decision for a design, used by the public template endpoint and by
// project creation. `variantGated` = the design belongs to ≥1 variant (so it must
// never be publicly browsable); `allowed` = the viewer may use it (bought, or added
// with an active subscription, ANY variant containing it).
//
// This is the HARD gate: a locked template may be *listed* on a variant page, but
// opening one or starting a project from it fails here. Projects already created
// stay the user's own work and are not re-checked.
async function canAccessFamily(familyId, viewer) {
  const variantIds = await familyVariantIds(familyId);
  if (!variantIds.length) return { variantGated: false, allowed: true };
  const via = await accessVia(variantIds, viewer);
  return { variantGated: true, allowed: via.size > 0 };
}

// Same gate for one version (template row), via its family.
async function canAccessTemplate(templateId, viewer) {
  const tpl = await Template.findByPk(templateId, { attributes: ['family_id'] });
  if (!tpl) return { variantGated: false, allowed: false };
  return canAccessFamily(tpl.family_id, viewer);
}

module.exports = {
  activePlanId, addedVariantIds, purchasedVariantIds, isVariantUnlocked, accessVia, unlockedVariantIds,
  familyVariantIds, templateVariantIds, canAccessFamily, canAccessTemplate,
};
