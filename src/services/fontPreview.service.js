const crypto  = require('crypto');
const s3      = require('../utils/s3Helper');
const { subset } = require('../utils/fontSubset');
const { Font, FontFile, User } = require('../models');

/**
 * Name-only previews for the font picker.
 *
 * Each font gets a tiny WOFF2 holding just the glyphs of its own family name, so
 * the picker can draw ~2,000 names in their own faces by loading a few KB per
 * visible row instead of whole font files. `fonts.preview_s3_key` points at it;
 * null means "show the name in the app font" (see utils/fontSubset.js for when).
 *
 * Deliberate choices, mirroring project thumbnails (projectThumbnail.service.js):
 *   - The key carries a content hash, and objects are never overwritten. The
 *     preview is served with a year-long immutable cache, so a renamed font or
 *     replaced file MUST come out under a new key or browsers would keep drawing
 *     the old name. The previous object is deleted once the new one is written.
 *   - Not charged to storage quota and not in the uploads ledger: it is a
 *     derivative of the font, a few KB, and not something the user manages.
 *   - A user's preview lives under users/<uid>/ so the account purge sweeps it.
 *   - Best-effort. A preview is a nicety; failing to make one must never fail the
 *     upload, rename or file change that triggered it. Errors are logged and the
 *     font is left with no preview (which the backfill can retry).
 *
 * Locked premium fonts get a preview like any other — it can only draw the
 * font's own name, so it gives nothing away (cf. thumbnail_s3_key on locked
 * assets), and a premium font should look like itself in the list.
 */

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Formats the subsetter can read. woff2 is excluded: decoding it needs the glyf
// transform reversed, and every library font has a TTF anyway (Flutter needs it).
const READABLE = ['ttf', 'otf', 'woff'];

const prefixFor = (font) => (font.user_id == null
  ? 'fonts/previews/'
  : `users/${font.User.uid}/fonts/previews/`);

const keyFor = (font, hash) => `${prefixFor(font)}${font.uid}-${hash}.woff2`;

// The regular face: weight 400 upright, else the upright file nearest 400, else
// anything readable (an italic-only family still gets a preview).
function pickSource(files = []) {
  const readable = files.filter((f) => READABLE.includes(f.format));
  if (!readable.length) return null;
  const byDistance = (a, b) => Math.abs((a.weight || 400) - 400) - Math.abs((b.weight || 400) - 400);
  const upright = readable.filter((f) => (f.style || 'normal') === 'normal').sort(byDistance);
  return upright[0] || readable.sort(byDistance)[0];
}

// Only delete what this service wrote — a hand-set key elsewhere is left alone.
async function dropObject(font, key) {
  if (!key || !key.startsWith(prefixFor(font))) return;
  try { await s3.deleteFile(key); } catch (err) {
    console.warn(`[FontPreview] could not delete ${key}: ${err.message}`);
  }
}

const load = (fontOrId) => Font.findOne({
  where: { id: typeof fontOrId === 'object' ? fontOrId.id : fontOrId },
  include: [
    { model: FontFile, attributes: ['weight', 'style', 'format', 's3_key'] },
    { model: User, attributes: ['uid'] },
  ],
});

/**
 * (Re)build a font's preview from its current family and files and save the key
 * on the row. When `target` is a Font instance it is updated in place too, so a
 * caller about to serialise it returns the new key.
 *
 * @returns {{ preview_s3_key: string|null, reason: string|null }} — reason says
 *   why there is no preview (a fontSubset reason, or no_readable_file /
 *   source_unavailable / error).
 */
async function generate(target) {
  const font = await load(target);
  if (!font) return { preview_s3_key: null, reason: 'not_found' };

  let key = null;
  let reason = null;
  try {
    const source = pickSource(font.FontFiles);
    if (!source) {
      reason = 'no_readable_file';
    } else {
      let bytes;
      try { bytes = await s3.getObjectBuffer(source.s3_key); } catch (err) {
        console.warn(`[FontPreview] ${font.uid}: cannot read ${source.s3_key}: ${err.message}`);
        reason = 'source_unavailable';
      }
      if (bytes) {
        const result = subset(bytes, font.family);
        if (result.bytes) {
          const hash = crypto.createHash('sha1').update(result.bytes).digest('hex').slice(0, 12);
          key = keyFor(font, hash);
          if (key !== font.preview_s3_key) {
            await s3.uploadFile(key, result.bytes, 'font/woff2', { cacheControl: CACHE_CONTROL });
          }
        } else {
          reason = result.reason;
        }
      }
    }
  } catch (err) {
    console.warn(`[FontPreview] ${font.uid} (${font.family}): ${err.message}`);
    key = null;
    reason = 'error';
  }

  // An unreadable source is a transient failure: keep whatever preview exists
  // rather than blanking a working one because S3 hiccuped.
  if (reason === 'source_unavailable') return { preview_s3_key: font.preview_s3_key, reason };

  const previous = font.preview_s3_key;
  if (key !== previous) {
    await Font.update({ preview_s3_key: key }, { where: { id: font.id } });
    await dropObject(font, previous);
  }
  if (target && typeof target.set === 'function') target.set('preview_s3_key', key, { raw: true });
  return { preview_s3_key: key, reason };
}

// Best-effort wrapper for request paths: never throws.
async function refresh(target) {
  try { return await generate(target); } catch (err) {
    console.warn(`[FontPreview] refresh failed: ${err.message}`);
    return { preview_s3_key: null, reason: 'error' };
  }
}

// Called after the font row is gone; `font` must still carry uid, user_id and
// preview_s3_key (and User for an own font, or `userUid`).
async function remove(font, { userUid } = {}) {
  if (!font || !font.preview_s3_key) return;
  const owner = font.User || (userUid ? { uid: userUid } : null);
  if (font.user_id != null && !owner) return;
  await dropObject({ uid: font.uid, user_id: font.user_id, User: owner }, font.preview_s3_key);
}

/**
 * Backfill: build previews for every font (library and users' own) that has
 * none, or for all of them with `force`. Sequential on purpose — each one reads a
 * whole font file into memory on a small host.
 */
async function rebuildAll({ force = false } = {}) {
  const where = force ? {} : { preview_s3_key: null };
  const fonts = await Font.findAll({ where, attributes: ['id', 'uid', 'family', 'user_id'], order: [['id', 'ASC']] });
  const report = [];
  for (const f of fonts) {
    const r = await refresh(f.id);
    report.push({ uid: f.uid, family: f.family, is_library: f.user_id == null, ...r });
  }
  return report;
}

module.exports = { generate, refresh, remove, rebuildAll, pickSource, CACHE_CONTROL };
