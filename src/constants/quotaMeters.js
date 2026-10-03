const { ValidationError } = require('../errors');

// Every plan-feature key the code can actually METER.
//
// An integer plan feature is a promise ("500 Business Posts a month"), and a
// promise nothing enforces is a lie on the plan card. So this list is the gate:
// an admin can only create or edit an integer feature type whose key is here
// (see assertMeterable, wired as the /admin/feature-types beforeWrite). Boolean
// features are capabilities, not meters, and are not listed.
//
// Keys match the rows admins already created rather than a fresh naming scheme —
// renaming them would break every plan that points at them.
//
//   scale          counter units per plan unit. Storage is set in MB on the plan
//                  but counted in bytes; everything else is a plain count.
//   resets         reset periods this meter makes sense with. Storage is
//                  occupancy, so a "monthly" storage reset would hand out free space.
//   liveCount      for meters whose usage is a HOLDING (frames on the shelf,
//                  series adopted, projects kept) rather than a spend: when the
//                  feature is a gauge (reset 'never'), `used` is counted from the
//                  live rows instead of a counter, so removing the thing frees the
//                  slot by construction and nothing can drift. As a flow (monthly/
//                  annual) the same meter is a tally of ADDS instead, and removing
//                  gives nothing back.
//
// Models are required inside the counters: this file is loaded by the admin
// router and quota.service, both of which are loaded while models/index.js is
// still being assembled in some entry points.
const ALL_RESETS = ['monthly', 'annual', 'never'];

// Template families are image, video or animated; the plan sells two buckets.
const TEMPLATE_METER = {
  image:    'business_posts_templates',
  video:    'video_templates',
  animated: 'video_templates',
};

const typesFor = (meterKey) => Object.keys(TEMPLATE_METER).filter((t) => TEMPLATE_METER[t] === meterKey);

// Projects created from a template of the given types that the user still keeps
// (archived = deleted from the user's point of view).
async function liveTemplateProjects(userId, meterKey) {
  const { Op } = require('sequelize');
  const { Project, Template, TemplateFamily } = require('../models');
  return Project.count({
    where: { user_id: userId, template_id: { [Op.ne]: null }, status: { [Op.ne]: 'archived' } },
    include: [{
      model: Template, attributes: [], required: true,
      include: [{ model: TemplateFamily, as: 'family', attributes: [], required: true, where: { template_type: typesFor(meterKey) } }],
    }],
  });
}

// Distinct brand series the user holds through any of their businesses. With
// `seriesId`, whether they hold that one series (0 or 1).
async function heldSeriesCount(userId, seriesId = null) {
  const sequelize = require('../config/db');
  const [[row]] = await sequelize.query(
    `SELECT COUNT(DISTINCT v.series_id) AS n
       FROM business_variants bv
       JOIN businesses b ON b.id = bv.business_id
       JOIN variants   v ON v.id = bv.variant_id
      WHERE b.user_id = :userId${seriesId ? ' AND v.series_id = :seriesId' : ''}`,
    { replacements: { userId, seriesId } },
  );
  return Number(row?.n || 0);
}

const METERS = {
  downloads:      { label: 'Downloads',      resets: ALL_RESETS },
  shares:         { label: 'Shares',         resets: ALL_RESETS },
  ai_credits:     { label: 'AI Credits',     resets: ALL_RESETS },
  template_views: { label: 'Template Views', resets: ALL_RESETS },
  storage:        { label: 'Storage (MB)',   resets: ['never'], scale: 1024 * 1024, unit: 'MB' },

  business_posts_templates: {
    label: 'Business Posts Templates', resets: ALL_RESETS,
    liveCount: (userId) => liveTemplateProjects(userId, 'business_posts_templates'),
  },
  video_templates: {
    label: 'Video Templates', resets: ALL_RESETS,
    liveCount: (userId) => liveTemplateProjects(userId, 'video_templates'),
  },
  // Distinct SERIES, across every business the user owns — a second variant of a
  // series they already hold is not a second brand series.
  brand_series: {
    label: 'Brand Series', resets: ALL_RESETS,
    // Raw SQL: business_variants deliberately has no associations (see its model).
    liveCount: (userId) => heldSeriesCount(userId),
  },
  // Only frames added for free count. A premium frame was bought outright, per
  // frame, so the plan cap must never stand between a user and what they paid for.
  frames: {
    label: 'Brand Frames', resets: ALL_RESETS,
    liveCount: (userId) => {
      const { UserFrame } = require('../models');
      return UserFrame.count({ where: { user_id: userId, status: 'active', acquired_via: 'free' } });
    },
  },
};

const isMeter    = (key) => Object.prototype.hasOwnProperty.call(METERS, key);
const scaleFor   = (key) => METERS[key]?.scale || 1;
const unitFor    = (key) => METERS[key]?.unit || 'count';
const templateMeterFor = (templateType) => TEMPLATE_METER[templateType] || null;

// The shape a feature type gives a meter. Derived from the row rather than held
// in a map, so changing a feature's reset period in the admin panel is enough to
// switch it between "N per month" and "at most N at a time".
const modeOf = (featureType) => (featureType?.reset_period === 'never' ? 'gauge' : 'flow');

// beforeWrite for /admin/feature-types. `merged` is the row as it will be after
// the write (existing values overlaid with the patch), so a PATCH that only
// flips data_type to integer is judged on the key it already has.
function assertMeterable(merged) {
  const dataType = merged.data_type || 'integer';   // the column default
  if (dataType !== 'integer') return;

  if (!isMeter(merged.key)) {
    throw new ValidationError(
      `"${merged.key}" cannot be an integer feature: nothing in the app meters it. ` +
      'Use one of the metered keys, or make it a boolean feature.',
      { metered_keys: Object.keys(METERS) },
    );
  }
  const reset = merged.reset_period || 'never';
  if (!METERS[merged.key].resets.includes(reset)) {
    throw new ValidationError(
      `"${merged.key}" cannot reset ${reset}`,
      { allowed_reset_periods: METERS[merged.key].resets },
    );
  }
}

// For the admin FE's key dropdown.
const listMeters = () => Object.entries(METERS).map(([key, m]) => ({
  key, label: m.label, unit: unitFor(key), reset_periods: m.resets,
}));

module.exports = {
  METERS, TEMPLATE_METER, isMeter, scaleFor, unitFor, templateMeterFor, modeOf,
  assertMeterable, listMeters, heldSeriesCount,
};
