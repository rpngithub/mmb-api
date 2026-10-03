const cron         = require('node-cron');
const { Op }       = require('sequelize');
const { Template, TemplateFamily, ActivityLog, sequelize } = require('../models');

const WEIGHT_VIEW     = 1;
const WEIGHT_DOWNLOAD = 3;
const WEIGHT_LIKE     = 2;

async function recalculateTrendingScores() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const logs = await ActivityLog.findAll({
    where: {
      entity_type: 'template',
      action:      { [Op.in]: ['template_view', 'template_download', 'template_like'] },
      created_at:  { [Op.gte]: since },
    },
    attributes: ['entity_id', 'action', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
    group:       ['entity_id', 'action'],
    raw:         true,
  });

  // Activity names the VERSION a user opened; trending belongs to the DESIGN, so
  // every language and size of a family scores together.
  const versionIds = [...new Set(logs.map((row) => row.entity_id))];
  const versions   = versionIds.length
    ? await Template.findAll({ where: { id: { [Op.in]: versionIds } }, attributes: ['id', 'family_id'], raw: true })
    : [];
  const familyOf = new Map(versions.map((v) => [v.id, v.family_id]));

  const scores = {};
  for (const row of logs) {
    const id = familyOf.get(row.entity_id);
    if (!id) continue; // version since deleted
    if (!scores[id]) scores[id] = 0;
    const w = row.action === 'template_view'     ? WEIGHT_VIEW
            : row.action === 'template_download' ? WEIGHT_DOWNLOAD
            : WEIGHT_LIKE;
    scores[id] += parseInt(row.count, 10) * w;
  }

  await Promise.all(
    Object.entries(scores).map(([id, score]) =>
      TemplateFamily.update({ trending_score: score }, { where: { id } })
    )
  );

  console.log(`[TrendingJob] Updated ${Object.keys(scores).length} template families`);
}

const job = cron.schedule('0 2 * * *', async () => {
  console.log('[TrendingJob] Running...');
  try { await recalculateTrendingScores(); }
  catch (err) { console.error('[TrendingJob] Error:', err.message); }
}, { scheduled: false });

module.exports = { job, recalculateTrendingScores };
