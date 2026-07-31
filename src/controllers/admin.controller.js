const adminService    = require('../services/admin.service');
const templateService = require('../services/template.service');
const activity        = require('../services/activity.service');
const uploadService   = require('../services/upload.service');
const s3              = require('../utils/s3Helper');
const { BusinessCategory, Tag, Template, Variant, VariantBadge, BrandSeries, StylePersonality, Color, Asset, TemplateSize, Plan, SpecialEvent, Coupon, sequelize } = require('../models');
const { NotFoundError, ValidationError } = require('../errors');

// A template's relations, as compact id-bearing lists (for the editor to load/preselect).
const findTemplateWithRelations = (uid) => Template.findOne({
  where: { uid },
  attributes: ['id', 'uid', 'name'],
  include: [
    { model: Tag,              through: { attributes: [] }, attributes: ['id', 'slug', 'name'] },
    { model: TemplateSize,     through: { attributes: [] }, attributes: ['id', 'slug', 'name', 'width', 'height'] },
    { model: Variant,          through: { attributes: [] }, attributes: ['id', 'uid', 'name'] },
    { model: BusinessCategory, through: { attributes: [] }, attributes: ['id', 'uid', 'slug', 'name'] },
  ],
});

const findAssetWithTags = (uid) => Asset.findOne({
  where: { uid },
  include: [{ model: Tag, through: { attributes: [] } }],
});

// Lightweight template shape for variant-assignment views (never pull the heavy `content` blob).
const VARIANT_TEMPLATE_ATTRS = ['id', 'uid', 'name', 'thumbnail_s3_key', 'status', 'template_type'];
const findVariantWithTemplates = (uid) => Variant.findOne({
  where: { uid },
  include: [{ model: Template, through: { attributes: [] }, attributes: VARIANT_TEMPLATE_ATTRS }],
});

// A variant's relations as compact id-bearing lists: the plans entitled to its
// templates and the industries it's tagged with (for the admin editor).
const findVariantWithRelations = (uid) => Variant.findOne({
  where: { uid },
  attributes: ['id', 'uid', 'name'],
  include: [
    { model: Plan,             through: { attributes: [] }, attributes: ['id', 'uid', 'name'] },
    { model: BusinessCategory, through: { attributes: [] }, attributes: ['id', 'uid', 'slug', 'name'] },
    { model: VariantBadge,     attributes: ['id', 'uid', 'slug', 'name', 'icon_s3_key'] },
  ],
});

// A brand series' descriptive relations. Purely presentational - no gating lives here.
const findSeriesWithRelations = (uid) => BrandSeries.findOne({
  where: { uid },
  attributes: ['id', 'uid', 'name'],
  include: [
    { model: StylePersonality, through: { attributes: ['display_order'] }, attributes: ['id', 'uid', 'slug', 'name'] },
    { model: Tag,              through: { attributes: [] },                attributes: ['id', 'slug', 'name'] },
    { model: Color,            through: { attributes: ['display_order'] }, attributes: ['id', 'uid', 'slug', 'name', 'hex_code'] },
  ],
});

// Sequelize cannot ORDER BY a through-table column, so the two ordered collections are
// sorted here and their join payload dropped before the row goes out.
const sortSeriesRelations = (row) => {
  const data = row.toJSON();
  for (const [key, through] of [['StylePersonalities', 'BrandSeriesStylePersonality'], ['Colors', 'BrandSeriesColor']]) {
    if (!Array.isArray(data[key])) continue;
    data[key] = data[key]
      .sort((a, b) => (a[through]?.display_order ?? 0) - (b[through]?.display_order ?? 0))
      .map(({ [through]: drop, ...rest }) => rest);
  }
  return data;
};

// Full-replace an ordered M2M, writing the array position into the join row's
// display_order so the admin's drag order round-trips without a second endpoint.
const setOrdered = async (series, collection, ids) => {
  await series[`set${collection}`](ids);
  const through = collection === 'Colors' ? 'BrandSeriesColor' : 'BrandSeriesStylePersonality';
  const rows = await series[`get${collection}`]();
  await Promise.all(rows.map((r) => {
    const order = ids.indexOf(r.id);
    return order < 0 ? null : r[through].update({ display_order: order });
  }));
};

const listAdmins = async (req, res) => {
  const result = await adminService.listAdmins(req.query);
  res.json({ success: true, data: result.rows, meta: { total: result.count } });
};

const getAdmin = async (req, res) => {
  res.json({ success: true, data: await adminService.getAdmin(req.params.uid) });
};

const createAdmin = async (req, res) => {
  const admin = await adminService.createAdmin(req.body);
  await activity.log(req, { action: 'admin.created', entityType: 'admin_user', entityId: admin.id });
  res.status(201).json({ success: true, data: admin });
};

const updateAdmin = async (req, res) => {
  const admin = await adminService.updateAdmin(req.params.uid, req.body);
  await activity.log(req, { action: 'admin.updated', entityType: 'admin_user', entityId: admin.id });
  res.json({ success: true, data: admin });
};

const setAdminStatus = async (req, res) => {
  const admin = await adminService.setAdminActive(req.params.uid, req.body.is_active);
  await activity.log(req, { action: 'admin.status_changed', entityType: 'admin_user', entityId: admin.id, metadata: { is_active: req.body.is_active } });
  res.json({ success: true, data: admin });
};

const listUsers = async (req, res) => {
  const result = await adminService.listUsers(req.query);
  res.json({ success: true, data: result.rows, meta: { total: result.count } });
};

const getUser = async (req, res) => {
  res.json({ success: true, data: await adminService.getUser(req.params.uid) });
};

const setUserStatus = async (req, res) => {
  const user = await adminService.setUserActive(req.params.uid, req.body.is_active);
  await activity.log(req, { action: 'user.status_changed', entityType: 'user', entityId: user.id, metadata: { is_active: req.body.is_active } });
  res.json({ success: true, data: user });
};

const listActivity = async (req, res) => {
  const result = await adminService.listActivity(req.query);
  res.json({ success: true, data: result.rows, meta: { total: result.count } });
};

// Full-replace the tags on a business category. The generic CRUD only writes scalar
// columns, so the many-to-many is managed through this dedicated route.
const setBusinessCategoryTags = async (req, res) => {
  const cat = await BusinessCategory.findOne({ where: { uid: req.params.uid } });
  if (!cat) throw new NotFoundError('business_category not found');
  await cat.setTags(req.body.tag_ids);
  await activity.log(req, { action: 'business_category.tags_updated', entityType: 'business_category', entityId: cat.id, metadata: { tag_ids: req.body.tag_ids } });
  const updated = await BusinessCategory.findOne({
    where: { uid: req.params.uid },
    include: [{ model: Tag, through: { attributes: [] } }],
  });
  res.json({ success: true, data: updated });
};

const listTemplates = async (req, res) => {
  const result = await templateService.listTemplatesForAdmin(req.query);
  res.json({ success: true, data: result.rows, meta: { total: result.count } });
};

// `Industries` is the current public name for business categories (matching the
// `industry_ids` key the PUT takes). `BusinessCategories` — the raw Sequelize include
// key — is kept as a deprecated duplicate so existing clients don't break.
const withIndustries = (tpl) => {
  const data = tpl.toJSON();
  data.Industries = data.BusinessCategories || [];
  return data;
};

// Read a template's current relations (tags / sizes / variants / industries).
const getTemplateRelations = async (req, res) => {
  const tpl = await findTemplateWithRelations(req.params.uid);
  if (!tpl) throw new NotFoundError('template not found');
  res.json({ success: true, data: withIndustries(tpl) });
};

// Unified relation assignment. Any provided key is a FULL REPLACE of that relation; omitted
// keys are left untouched. The generic CRUD only writes scalar columns, so M2M lives here.
const setTemplateRelations = async (req, res) => {
  const tpl = await Template.findOne({ where: { uid: req.params.uid } });
  if (!tpl) throw new NotFoundError('template not found');

  const { tag_ids, size_ids } = req.body;
  // `industry_ids` / `variant_ids` are the public names; `business_category_ids` and
  // `theme_ids` are the deprecated aliases.
  const industry_ids = req.body.industry_ids ?? req.body.business_category_ids;
  const variant_ids  = req.body.variant_ids  ?? req.body.theme_ids;
  if (tag_ids !== undefined)       await tpl.setTags(tag_ids);
  if (size_ids !== undefined)      await tpl.setTemplateSizes(size_ids);
  if (industry_ids !== undefined)  await tpl.setBusinessCategories(industry_ids);
  if (variant_ids !== undefined)   await tpl.setVariants(variant_ids);

  await activity.log(req, { action: 'template.relations_updated', entityType: 'template', entityId: tpl.id, metadata: { tag_ids, size_ids, industry_ids, variant_ids } });
  res.json({ success: true, data: withIndustries(await findTemplateWithRelations(req.params.uid)) });
};

// Finalize a template bundle: flip every object under templates/<uid>/ from pending to
// active, then persist the editor JSON + thumbnail key. Bundle files were uploaded directly
// to their final keys (names preserved) via the generic upload endpoints with
// target { type:'template_file', template_uid }.
const confirmTemplateBundle = async (req, res) => {
  const tpl = await Template.findOne({ where: { uid: req.params.uid } });
  if (!tpl) throw new NotFoundError('template not found');

  const prefix = `templates/${tpl.uid}/`;
  const keys = await s3.listKeys(prefix);
  for (const key of keys) await s3.putObjectTagging(key, 'active');

  // Both keys are optional (schema enforces at least one): sending only
  // `thumbnail_filename` swaps the thumbnail without re-uploading the bundle.
  const patch = {};
  if (req.body.content !== undefined) patch.content = req.body.content;
  if (req.body.thumbnail_filename) {
    patch.thumbnail_s3_key = uploadService.buildKey({ type: 'template_file', template_uid: tpl.uid }, req.body.thumbnail_filename);
  }
  await tpl.update(patch);
  await activity.log(req, { action: 'template.bundle_confirmed', entityType: 'template', entityId: tpl.id, metadata: { objects: keys.length } });
  res.json({ success: true, data: tpl });
};

// Read the tags currently assigned to an asset (M2M not handled by generic CRUD).
const getAssetTags = async (req, res) => {
  const asset = await findAssetWithTags(req.params.uid);
  if (!asset) throw new NotFoundError('asset not found');
  res.json({ success: true, data: asset });
};

// Full-replace the tags assigned to an asset.
const setAssetTags = async (req, res) => {
  const asset = await Asset.findOne({ where: { uid: req.params.uid } });
  if (!asset) throw new NotFoundError('asset not found');
  await asset.setTags(req.body.tag_ids);
  await activity.log(req, { action: 'asset.tags_updated', entityType: 'asset', entityId: asset.id, metadata: { tag_ids: req.body.tag_ids } });
  res.json({ success: true, data: await findAssetWithTags(req.params.uid) });
};

// Lightweight template shape for event-assignment views (same as variant, no heavy `content`).
const findEventWithTemplates = (uid) => SpecialEvent.findOne({
  where: { uid },
  include: [{ model: Template, through: { attributes: [] }, attributes: THEME_TEMPLATE_ATTRS }],
});

// Read the templates currently linked to a special event (M2M not handled by generic CRUD).
const getEventTemplates = async (req, res) => {
  const event = await findEventWithTemplates(req.params.uid);
  if (!event) throw new NotFoundError('special_event not found');
  res.json({ success: true, data: event });
};

// Full-replace the templates linked to a special event (curates the calendar's "event -> designs").
const setEventTemplates = async (req, res) => {
  const event = await SpecialEvent.findOne({ where: { uid: req.params.uid } });
  if (!event) throw new NotFoundError('special_event not found');
  await event.setTemplates(req.body.template_ids);
  await activity.log(req, { action: 'special_event.templates_updated', entityType: 'special_event', entityId: event.id, metadata: { template_ids: req.body.template_ids } });
  res.json({ success: true, data: await findEventWithTemplates(req.params.uid) });
};

// Read the templates currently assigned to a variant (M2M not handled by generic CRUD).
const getVariantTemplates = async (req, res) => {
  const variant = await findVariantWithTemplates(req.params.uid);
  if (!variant) throw new NotFoundError('variant not found');
  res.json({ success: true, data: variant });
};

// Full-replace the templates assigned to a variant.
const setVariantTemplates = async (req, res) => {
  const variant = await Variant.findOne({ where: { uid: req.params.uid } });
  if (!variant) throw new NotFoundError('variant not found');
  await variant.setTemplates(req.body.template_ids);
  await activity.log(req, { action: 'variant.templates_updated', entityType: 'variant', entityId: variant.id, metadata: { template_ids: req.body.template_ids } });
  res.json({ success: true, data: await findVariantWithTemplates(req.params.uid) });
};

// Read a variant's relations (plan entitlements + industries).
const getVariantRelations = async (req, res) => {
  const variant = await findVariantWithRelations(req.params.uid);
  if (!variant) throw new NotFoundError('variant not found');
  res.json({ success: true, data: withIndustries(variant) });
};

// Set a theme's relations. Any provided key is a FULL REPLACE of that relation; omitted
// keys are left untouched. plan_ids drive the premium entitlement (empty array = locked
// to everyone); business_category_ids are the display/filter tags.
const setVariantRelations = async (req, res) => {
  const variant = await Variant.findOne({ where: { uid: req.params.uid } });
  if (!variant) throw new NotFoundError('variant not found');

  const { plan_ids } = req.body;
  // `industry_ids` is the public name; `business_category_ids` the deprecated alias.
  const industry_ids = req.body.industry_ids ?? req.body.business_category_ids;
  if (plan_ids !== undefined)      await variant.setPlans(plan_ids);
  if (industry_ids !== undefined)  await variant.setBusinessCategories(industry_ids);

  await activity.log(req, { action: 'variant.relations_updated', entityType: 'variant', entityId: variant.id, metadata: { plan_ids, industry_ids } });
  res.json({ success: true, data: withIndustries(await findVariantWithRelations(req.params.uid)) });
};

// ---- Brand series relations (style personalities / tags / colours) ----
// Each provided key is a FULL REPLACE. The two ordered collections take their
// display_order from the ARRAY ORDER, so the admin can drag to reorder in place.
const getBrandSeriesRelations = async (req, res) => {
  const series = await findSeriesWithRelations(req.params.uid);
  if (!series) throw new NotFoundError('brand series not found');
  res.json({ success: true, data: sortSeriesRelations(series) });
};

const setBrandSeriesRelations = async (req, res) => {
  const series = await BrandSeries.findOne({ where: { uid: req.params.uid } });
  if (!series) throw new NotFoundError('brand series not found');

  const { style_personality_ids, tag_ids, color_ids } = req.body;
  if (style_personality_ids !== undefined) await setOrdered(series, 'StylePersonalities', style_personality_ids);
  if (tag_ids !== undefined)               await series.setTags(tag_ids);
  if (color_ids !== undefined)             await setOrdered(series, 'Colors', color_ids);

  await activity.log(req, { action: 'brand_series.relations_updated', entityType: 'brand_series', entityId: series.id, metadata: { style_personality_ids, tag_ids, color_ids } });
  res.json({ success: true, data: sortSeriesRelations(await findSeriesWithRelations(req.params.uid)) });
};

// A coupon with the plans it is scoped to (compact, for the admin editor's multi-select).
const findCouponWithPlans = (uid) => Coupon.findOne({
  where: { uid },
  attributes: ['id', 'uid', 'code', 'title', 'applicable_to'],
  include: [{ model: Plan, as: 'plans', through: { attributes: [] }, attributes: ['id', 'uid', 'name'] }],
});

const getCouponPlans = async (req, res) => {
  const coupon = await findCouponWithPlans(req.params.uid);
  if (!coupon) throw new NotFoundError('coupon not found');
  res.json({ success: true, data: coupon });
};

// Full-replace the plans a coupon is scoped to, and keep `applicable_to` in step:
// a non-empty list means `specific_plans`, an empty list clears the scoping back to
// `all_plans`. Keeping the two in one transaction is the point of this endpoint —
// the pair is what makes a coupon redeemable, and setting them independently is how
// you end up with a `specific_plans` coupon that matches no plan at all.
const setCouponPlans = async (req, res) => {
  const coupon = await Coupon.findOne({ where: { uid: req.params.uid } });
  if (!coupon) throw new NotFoundError('coupon not found');

  const { plan_ids } = req.body;
  if (plan_ids.length) {
    const wanted = [...new Set(plan_ids)];
    const found  = await Plan.findAll({ where: { id: wanted }, attributes: ['id', 'name', 'plan_type'], raw: true });
    if (found.length !== wanted.length) throw new NotFoundError('One or more plans were not found');

    // An access-pass plan is bought through POST /subscriptions/access-pass, which
    // takes no coupon code — scoping a coupon to one would make it unredeemable.
    const passes = found.filter((p) => p.plan_type === 'access_pass');
    if (passes.length) {
      throw new ValidationError('Coupons cannot be scoped to an access-pass plan', passes.map((p) => ({
        field:   'plan_ids',
        message: `${p.name} is an access pass — it is bought without a coupon code, so a coupon scoped to it could never be used`,
      })));
    }
  }

  await sequelize.transaction(async (t) => {
    await coupon.setPlans(plan_ids, { transaction: t });
    await coupon.update({ applicable_to: plan_ids.length ? 'specific_plans' : 'all_plans' }, { transaction: t });
  });

  await activity.log(req, { action: 'coupon.plans_updated', entityType: 'coupon', entityId: coupon.id, metadata: { plan_ids } });
  res.json({ success: true, data: await findCouponWithPlans(req.params.uid) });
};

// Wipe a template's bundle prefix so it can be cleanly re-uploaded.
const resetTemplateBundle = async (req, res) => {
  const tpl = await Template.findOne({ where: { uid: req.params.uid } });
  if (!tpl) throw new NotFoundError('template not found');
  await s3.deleteByPrefix(`templates/${tpl.uid}/`);
  await activity.log(req, { action: 'template.bundle_reset', entityType: 'template', entityId: tpl.id });
  res.json({ success: true, data: null });
};

module.exports = { listAdmins, getAdmin, createAdmin, updateAdmin, setAdminStatus, listUsers, getUser, setUserStatus, listActivity, setBusinessCategoryTags, getAssetTags, setAssetTags, getVariantTemplates, setVariantTemplates, getVariantRelations, setVariantRelations, getBrandSeriesRelations, setBrandSeriesRelations, getTemplateRelations, setTemplateRelations, getEventTemplates, setEventTemplates, getCouponPlans, setCouponPlans, listTemplates, confirmTemplateBundle, resetTemplateBundle };
