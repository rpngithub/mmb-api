const { Op } = require('sequelize');
const { Business, BusinessTheme, ThemeTemplate, ThemePlanRestriction } = require('../models');
const userSubRepo = require('../repositories/userSubscription.repository');

// Central authority for premium-theme access. Two ways to reach a theme's templates:
//   1. ENTITLEMENT — the viewer's ACTIVE subscription plan is in the theme's allowed set.
//   2. ADOPTION    — the viewer owns a business that has adopted the theme. Adoption is
//      gated by entitlement at add-time, so it stands as a DURABLE grant afterwards
//      (a lapsed plan still keeps adopted themes usable).
// A theme with no allowed plans can never be entitled or adopted → locked to everyone.
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

// Does the viewer own a business that has adopted any of the given theme(s)?
async function hasAdopted(userId, themeIds) {
  if (!userId) return false;
  const ids = asArray(themeIds);
  if (!ids.length) return false;
  const businesses = await Business.findAll({ where: { user_id: userId }, attributes: ['id'] });
  if (!businesses.length) return false;
  const count = await BusinessTheme.count({
    where: { business_id: { [Op.in]: businesses.map((b) => b.id) }, theme_id: { [Op.in]: ids } },
  });
  return count > 0;
}

// Is the viewer's active plan in the given allowed set? (Strict entitlement — the
// rule for ADOPTING a theme; adoption itself does not count here.)
async function isPlanEntitled(allowedPlanIds, viewer) {
  if (!allowedPlanIds.length || !viewer?.userId) return false;
  const planId = await activePlanId(viewer);
  return Boolean(planId && allowedPlanIds.includes(planId));
}

// Can the viewer open a theme's templates? Entitled OR adopted.
async function isThemeUnlocked({ id, allowedPlanIds }, viewer) {
  if (viewer?.userId && (await hasAdopted(viewer.userId, id))) return true;
  return isPlanEntitled(allowedPlanIds, viewer);
}

// Theme ids a template belongs to (empty = not a theme template).
async function templateThemeIds(templateId) {
  const rows = await ThemeTemplate.findAll({ where: { template_id: templateId }, attributes: ['theme_id'] });
  return rows.map((r) => r.theme_id);
}

// Access decision for a single template, used by the public template endpoint and by
// project creation. `themeGated` = the template belongs to ≥1 theme (so it must never
// be publicly browsable); `allowed` = the viewer may use it (adopted any containing
// theme, or entitled to any of them).
async function canAccessTemplate(templateId, viewer) {
  const themeIds = await templateThemeIds(templateId);
  if (!themeIds.length) return { themeGated: false, allowed: true };
  if (!viewer?.userId)  return { themeGated: true, allowed: false };

  if (await hasAdopted(viewer.userId, themeIds)) return { themeGated: true, allowed: true };

  const planId = await activePlanId(viewer);
  if (!planId) return { themeGated: true, allowed: false };
  const matches = await ThemePlanRestriction.count({ where: { theme_id: { [Op.in]: themeIds }, plan_id: planId } });
  return { themeGated: true, allowed: matches > 0 };
}

module.exports = {
  activePlanId, hasAdopted, isPlanEntitled, isThemeUnlocked, templateThemeIds, canAccessTemplate,
};
