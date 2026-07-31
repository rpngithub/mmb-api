const { Op } = require('sequelize');
const { Business, BusinessVariant, VariantTemplate, VariantPlanRestriction } = require('../models');
const userSubRepo = require('../repositories/userSubscription.repository');

// Central authority for premium-variant access. Gating sits on the VARIANT, not on its
// parent Brand Series. Two ways to reach a variant's templates:
//   1. ENTITLEMENT — the viewer's ACTIVE subscription plan is in the variant's allowed set.
//   2. ADOPTION    — the viewer owns a business that has adopted the variant. Adoption is
//      gated by entitlement at add-time, so it stands as a DURABLE grant afterwards
//      (a lapsed plan still keeps adopted variants usable).
// A variant with no allowed plans can never be entitled or adopted → locked to everyone.
//
// The JWT only carries a coarse paid/free tier, never the plan_id, so plan checks use a
// per-request DB lookup (an upgrade must grant access immediately, not on token refresh).

const asArray = (v) => (Array.isArray(v) ? v : [v]);

// The viewer's active subscription plan id, or null (guest / no active sub).
async function activePlanId(viewer) {
  if (!viewer?.userId) return null;
  const sub = await userSubRepo.findActiveByUser(viewer.userId);
  return sub ? sub.plan_id : null;
}

// Does the viewer own a business that has adopted any of the given variant(s)?
async function hasAdopted(userId, variantIds) {
  if (!userId) return false;
  const ids = asArray(variantIds);
  if (!ids.length) return false;
  const businesses = await Business.findAll({ where: { user_id: userId }, attributes: ['id'] });
  if (!businesses.length) return false;
  const count = await BusinessVariant.count({
    where: { business_id: { [Op.in]: businesses.map((b) => b.id) }, variant_id: { [Op.in]: ids } },
  });
  return count > 0;
}

// Is the viewer's active plan in the given allowed set? (Strict entitlement — the
// rule for ADOPTING a variant; adoption itself does not count here.)
async function isPlanEntitled(allowedPlanIds, viewer) {
  if (!allowedPlanIds.length || !viewer?.userId) return false;
  const planId = await activePlanId(viewer);
  return Boolean(planId && allowedPlanIds.includes(planId));
}

// Can the viewer open a variant's templates? Entitled OR adopted.
async function isVariantUnlocked({ id, allowedPlanIds }, viewer) {
  if (viewer?.userId && (await hasAdopted(viewer.userId, id))) return true;
  return isPlanEntitled(allowedPlanIds, viewer);
}

// Bulk form of isVariantUnlocked: which of these variants can the viewer open?
// Fixed query count (3) no matter how many variants are asked about, so the brand
// series list can report an unlocked tally without a per-variant round trip.
async function unlockedVariantIds(variantIds, viewer) {
  const ids = [...new Set(asArray(variantIds))];
  const unlocked = new Set();
  if (!ids.length || !viewer?.userId) return unlocked;   // guests unlock nothing

  const businesses = await Business.findAll({ where: { user_id: viewer.userId }, attributes: ['id'] });
  if (businesses.length) {
    const adopted = await BusinessVariant.findAll({
      where: { business_id: { [Op.in]: businesses.map((b) => b.id) }, variant_id: { [Op.in]: ids } },
      attributes: ['variant_id'],
    });
    adopted.forEach((r) => unlocked.add(r.variant_id));
  }

  const planId = await activePlanId(viewer);
  if (planId) {
    const entitled = await VariantPlanRestriction.findAll({
      where: { variant_id: { [Op.in]: ids }, plan_id: planId },
      attributes: ['variant_id'],
    });
    entitled.forEach((r) => unlocked.add(r.variant_id));
  }
  return unlocked;
}

// Variant ids a template belongs to (empty = not a variant template).
async function templateVariantIds(templateId) {
  const rows = await VariantTemplate.findAll({ where: { template_id: templateId }, attributes: ['variant_id'] });
  return rows.map((r) => r.variant_id);
}

// Access decision for a single template, used by the public template endpoint and by
// project creation. `variantGated` = the template belongs to ≥1 variant (so it must never
// be publicly browsable); `allowed` = the viewer may use it (adopted any containing
// variant, or entitled to any of them).
//
// This is the HARD gate and is deliberately unchanged by the "show locked templates"
// work: a locked template may now be *listed* on a variant page, but opening one still
// fails here.
async function canAccessTemplate(templateId, viewer) {
  const variantIds = await templateVariantIds(templateId);
  if (!variantIds.length) return { variantGated: false, allowed: true };
  if (!viewer?.userId)    return { variantGated: true, allowed: false };

  if (await hasAdopted(viewer.userId, variantIds)) return { variantGated: true, allowed: true };

  const planId = await activePlanId(viewer);
  if (!planId) return { variantGated: true, allowed: false };
  const matches = await VariantPlanRestriction.count({ where: { variant_id: { [Op.in]: variantIds }, plan_id: planId } });
  return { variantGated: true, allowed: matches > 0 };
}

module.exports = {
  activePlanId, hasAdopted, isPlanEntitled, isVariantUnlocked, unlockedVariantIds,
  templateVariantIds, canAccessTemplate,
};
