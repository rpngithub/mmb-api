const models = require('../models');
const { probeKeys } = require('../utils/s3Probe');
const activity = require('./activity.service');
const { ASSET_TYPES } = require('../utils/assetTypes');
const { ValidationError } = require('../errors');

// ---- Asset file audit -------------------------------------------------------
//
// Bulk sheets imported before the importer started refusing rows whose file was
// not in S3 left the table with assets that point at nothing — a card the app
// cannot draw, and a record an editor cannot find by eye because it looks like
// every other row. This walks the table, HEADs every distinct key, and reports
// (or deletes) the rows whose `s3_key` or `thumbnail_s3_key` comes back 404.
//
// Two rules keep it from ever deleting a real asset:
//   - a row is "missing" only on an explicit 404. A probe that could not run
//     (bucket down, credentials wrong, throttled) is reported under `unverified`
//     and never deleted, and a run where NOTHING could be checked is refused.
//   - the delete re-scans at delete time rather than trusting an earlier report,
//     so a file uploaded between "look" and "delete" is safe.

const FILE_COLUMNS = ['s3_key', 'thumbnail_s3_key'];

const CATEGORY_ATTRS = ['id', 'uid', 'slug', 'name'];

// Optional narrowing, mirroring the admin list's filterable columns, so a
// cleanup can be run one category or one type at a time.
function buildWhere(filters = {}) {
  const where = {};
  if (filters.category_id !== undefined && filters.category_id !== '') {
    const id = Number(filters.category_id);
    if (!Number.isInteger(id) || id < 0) throw new ValidationError('category_id must be a non-negative integer');
    // 0 = the uncategorised rows (column is NULL); the same spelling the public
    // list uses for "no category", since nothing is ever inserted with id 0.
    where.category_id = id === 0 ? null : id;
  }
  if (filters.asset_type !== undefined && filters.asset_type !== '') {
    if (!ASSET_TYPES.includes(filters.asset_type)) {
      throw new ValidationError(`asset_type must be one of: ${ASSET_TYPES.join(', ')}`);
    }
    where.asset_type = filters.asset_type;
  }
  return where;
}

// What the report shows per row: enough to recognise the asset in the panel and
// to see which file is gone. `id` rides along for the delete; the panel keys on
// `uid` like every other admin list.
const shape = (a, missing) => ({
  id: a.id,
  uid: a.uid,
  name: a.name,
  asset_type: a.asset_type,
  status: a.status,
  is_premium: a.is_premium,
  category: a.AssetCategory ? a.AssetCategory.toJSON() : null,
  s3_key: a.s3_key,
  thumbnail_s3_key: a.thumbnail_s3_key,
  missing,
});

/**
 * Find every asset whose file or thumbnail is not in S3. Read-only.
 *
 * @returns {{ summary: { scanned, missing, unverified }, notes: string[], missing: object[], unverified: object[] }}
 */
async function scanMissingFiles(filters = {}) {
  const rows = await models.Asset.findAll({
    where: buildWhere(filters),
    include: [{ model: models.AssetCategory, attributes: CATEGORY_ATTRS }],
    order: [['id', 'ASC']],
  });

  const distinct = new Set();
  for (const a of rows) for (const col of FILE_COLUMNS) if (a[col]) distinct.add(a[col]);

  const { probes, unavailable } = await probeKeys(distinct);
  if (unavailable && distinct.size && !probes.size) {
    throw new ValidationError('S3 is unreachable or not configured, so no asset file could be checked. Nothing was changed — fix the S3 connection and retry.');
  }

  const missing = [];
  const unverified = [];
  for (const a of rows) {
    const gone = [];
    let unchecked = false;
    for (const col of FILE_COLUMNS) {
      const key = a[col];
      if (!key) continue;
      const probe = probes.get(key);
      if (!probe) { unchecked = true; continue; }
      if (!probe.exists) gone.push(col);
    }
    // A confirmed-missing file outranks an inconclusive one on the same row: the
    // row is unusable either way. Only a row with nothing confirmed missing and
    // at least one unchecked key lands in `unverified`.
    if (gone.length) missing.push(shape(a, gone));
    else if (unchecked) unverified.push(shape(a, []));
  }

  const notes = [];
  if (unverified.length) {
    notes.push(`${unverified.length} asset(s) could not be verified (S3 returned an error other than 404) — they are listed under unverified and are never deleted.`);
  }

  return {
    summary: { scanned: rows.length, missing: missing.length, unverified: unverified.length },
    notes,
    missing,
    unverified,
  };
}

/**
 * Delete every asset whose file or thumbnail is confirmed absent from S3. Scans
 * fresh rather than trusting a prior report; the tag links go with the row via
 * the asset_tags FK cascade. S3 objects are never touched — the ones that
 * matter are the ones that are not there.
 *
 * @returns the scan report plus `summary.deleted`
 */
async function purgeMissingFiles(filters = {}, req) {
  const report = await scanMissingFiles(filters);
  const ids = report.missing.map((m) => m.id);
  if (ids.length) await models.Asset.destroy({ where: { id: ids } });

  report.summary.deleted = ids.length;
  if (ids.length) {
    await activity.log(req, {
      action: 'asset.purged_missing_files',
      entityType: 'asset',
      metadata: { ...report.summary, filters: buildWhere(filters), uids: report.missing.map((m) => m.uid) },
    });
  }
  return report;
}

module.exports = { scanMissingFiles, purgeMissingFiles };
