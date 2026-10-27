const { v4: uuid } = require('uuid');
const s3 = require('../utils/s3Helper');
const uploadLimits = require('./uploadLimits.service');
const { ValidationError } = require('../errors');

// ---- Target registry: the client sends a typed target; the server derives the final key. ----
// Two key strategies:
//   'uuid'        -> <prefix>/<uuid>.<ext>           (standalone images & assets; name dropped)
//   'preserveName'-> templates/<uid>/<filename>      (bundle files; JSON references the name)
const IMAGE_SLOTS = {
  business_category_icon:      'categories/business/icon',
  business_category_thumbnail: 'categories/business/thumbnail',
  template_category_icon:      'categories/template/icon',
  template_category_thumbnail: 'categories/template/thumbnail',
  brand_series_icon:           'brand-series/icon',
  variant_thumbnail:           'variants/thumbnail',
  variant_badge_icon:          'variants/badge-icon',
  theme_thumbnail:             'variants/thumbnail',   // deprecated alias of variant_thumbnail
  special_event_thumbnail:     'events/thumbnail',
  frame_thumbnail:             'frames/thumbnail',
  special_event_banner:        'events/banner',
  // An asset's browse image. An image slot rather than a second `asset` target,
  // because the thumbnail is a PNG/JPG whatever the asset is — an audio clip and
  // a Lottie both need something to show — and it must not land in the
  // `assets/<asset_type>/` folder the deliverables live in. It is served to
  // viewers who have not paid for the asset, so upload a degraded copy.
  asset_thumbnail:             'assets/thumbnail',
  banner:                      'banners',
  testimonial:                 'testimonials',
  // Website page content (the editorial blocks under the template grid): the
  // section-level illustration and the per-card icon. Two slots, one root, so a
  // lifecycle or CDN rule can treat all marketing imagery alike.
  page_section_image:          'page-content/section',
  page_section_item_icon:      'page-content/item',
  // Not an image — a library font file (.woff2/.ttf/…). It shares this registry
  // because the key strategy is identical (uuid, name dropped), but it gets its
  // OWN root rather than living under `assets/font/`: a library font is a
  // `font_files` row, not an `assets` row, and mixing them would make the two
  // indistinguishable to a lifecycle or CDN rule.
  font_file:                   'fonts',
};
// Shared list — 'font' is deliberately not in it; library fonts use the
// `font_file` slot above and live under `fonts/`. See utils/assetTypes.js.
const { ASSET_TYPES } = require('./../utils/assetTypes');

// Any final key must live under one of these roots (re-validated on multipart complete/abort).
// 'themes/' is retained deliberately: thumbnails uploaded before the Brand Series rename
// still live there, and their stored keys must keep validating on re-save.
const ALLOWED_ROOTS = ['categories/', 'brand-series/', 'variants/', 'themes/', 'events/', 'banners/', 'testimonials/', 'assets/', 'templates/', 'fonts/', 'frames/', 'page-content/'];

const bad = (field, message) => new ValidationError('Validation failed', [{ field, message }]);

const ext = (filename) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : 'bin';
};

// Preserve a bundle filename but strip anything that could escape the prefix.
const safeName = (filename) =>
  String(filename || 'file').replace(/[^\w.\-]+/g, '_').replace(/_{2,}/g, '_').slice(0, 120);

// Derive the final S3 key from a typed target (never trust a raw key from the client).
function buildKey(target, filename) {
  if (!target || typeof target !== 'object') throw bad('target', 'target is required');

  switch (target.type) {
    case 'image_slot': {
      const prefix = IMAGE_SLOTS[target.slot];
      if (!prefix) throw bad('target.slot', `slot must be one of: ${Object.keys(IMAGE_SLOTS).join(', ')}`);
      return `${prefix}/${uuid()}.${ext(filename)}`;
    }
    case 'asset': {
      if (!ASSET_TYPES.includes(target.asset_type)) {
        throw bad('target.asset_type', `asset_type must be one of: ${ASSET_TYPES.join(', ')}`);
      }
      return `assets/${target.asset_type}/${uuid()}.${ext(filename)}`;
    }
    case 'template_file': {
      if (!target.template_uid) throw bad('target.template_uid', 'template_uid is required');
      return `templates/${target.template_uid}/${safeName(filename)}`;
    }
    default:
      throw bad('target.type', 'target.type must be image_slot | asset | template_file');
  }
}

// Guard for keys the client passes back (multipart complete/abort, confirm).
function assertAllowedKey(key) {
  if (!key || !ALLOWED_ROOTS.some((r) => key.startsWith(r))) {
    throw bad('key', 'key is outside the allowed upload roots');
  }
}

// ---- Type and size rules (app_settings `upload_admin_*`, see uploadLimits) ----
// Which kind of file a target must be. null = not type- or size-checked: audio,
// Lottie (`animated`), library fonts and template bundle files keep today's
// behaviour until they get rules of their own.
const IMAGE_ASSET_TYPES = ['icon', 'emoji', 'shape', 'bg'];
const kindOfAssetType = (assetType) => {
  if (assetType === 'video') return 'video';
  return IMAGE_ASSET_TYPES.includes(assetType) ? 'image' : null;
};

function kindForTarget(target) {
  if (target.type === 'image_slot') return target.slot === 'font_file' ? null : 'image';
  if (target.type === 'asset')      return kindOfAssetType(target.asset_type);
  return null;
}

// The same rule read back off a stored key, for the steps that only have the key.
function kindForKey(key) {
  if (key.startsWith('fonts/') || key.startsWith('templates/')) return null;
  const asset = /^assets\/([^/]+)\//.exec(key);
  if (asset && asset[1] !== 'thumbnail') return kindOfAssetType(asset[1]);
  return 'image';
}

// Validates one file against its target's rules. `at` is identity: presign
// re-points batch errors to `files.N.…` itself.
function checkFile({ target, filename, content_type, size }, limits) {
  const at       = (f) => f;
  const kind     = kindForTarget(target);
  const declared = size == null ? null : Number(size);
  if (kind) {
    uploadLimits.resolveType({ declared: content_type, filename, allowed: limits[kind].types, at });
    uploadLimits.assertFileSize({ kind, size: declared, limits, at });
  }
  return { kind, size: declared };
}

// Checks an uploaded object against its kind: present, within the size cap, and
// its first bytes matching its extension. A failing object is DELETED, so its key
// can never be saved onto a record. A HEAD or read that cannot be made is
// inconclusive and lets the object through, as on the user side.
async function assertStoredFileOk(key, limits, field) {
  const kind = kindForKey(key);
  if (!kind) return;
  const head = await s3.objectExists(key);
  if (!head) return;
  if (head.exists === false) throw bad(field, `no uploaded object found at ${key}`);

  const max = limits[kind].max_bytes;
  if (head.size != null && Number(head.size) > max) {
    await s3.deleteFile(key);
    throw bad(field, `file exceeds the ${uploadLimits.toMb(max)} MB limit`);
  }
  const type = uploadLimits.typeOfKey(key);
  if (type && uploadLimits.hasSignature(type)) {
    const start = await s3.readObjectStart(key, uploadLimits.SNIFF_BYTES);
    if (start && !uploadLimits.matchesSignature(type, start)) {
      await s3.deleteFile(key);
      throw bad(field, `file content is not a valid ${type} file`);
    }
  }
}

// ---- Multipart part plan ----
// With a declared size the server, not the client, picks the part size, so it can
// sign each part for its exact length. 10 MB parts (S3's minimum is 5 MB), grown
// only when a file would need more than S3's 10,000 parts.
const PART_SIZE = 10 * 1024 * 1024;
const MAX_PARTS = 10000;

function partPlan(size) {
  const part_size  = Math.max(PART_SIZE, Math.ceil(size / MAX_PARTS));
  const part_count = Math.ceil(size / part_size);
  return { part_size, part_count };
}
const partLength = ({ part_size, part_count }, n, size) =>
  (n < part_count ? part_size : size - part_size * (part_count - 1));

// ---- Single-PUT (small files) ----
//
// One file (`target` + `filename`) or a batch (`files: [...]`), and the response
// mirrors whichever was sent — flat for one, a `files` array for a batch. Same
// shape as the user-side endpoint, so a client that already speaks one speaks
// both.
//
// Targets may be mixed within a batch: uploading a category icon and its
// thumbnail together is the common case, and they are different slots.
//
// Sizes work as on the user side: a declared `size` is checked here (per file,
// and the request's combined total) and binds the URL to that length and content
// type. Without one the URL is unbound and confirm's HEAD is the only check.
async function presign(body) {
  const batch  = Array.isArray(body.files);
  const items  = batch ? body.files : [body];
  const limits = await uploadLimits.load('admin');

  // buildKey validates as it derives, so mapping it over every item first means a
  // batch with one bad target is rejected before ANY URL is issued. Nothing has
  // been uploaded at that point, so there is nothing to unwind.
  const checked = items.map((item, i) => {
    try {
      return { key: buildKey(item.target, item.filename), ...checkFile(item, limits) };
    } catch (err) {
      // Re-point the field at the offending entry, dot-indexed to match Joi.
      if (batch && err.details) {
        err.details = err.details.map((d) => ({ ...d, field: `files.${i}.${d.field}` }));
      }
      throw err;
    }
  });
  uploadLimits.assertBatch(checked, limits);

  const files = await Promise.all(checked.map(async ({ key, size }, i) => {
    const bound = size != null;
    const type  = items[i].content_type;
    return {
      key,
      upload_url:       await s3.getPresignedPutUrl(key, type, bound ? { contentLength: size } : {}),
      required_headers: {
        'x-amz-tagging': 'status=pending',
        ...(bound && type ? { 'Content-Type': type } : {}),
      },
      upload_method:    'single',
    };
  }));

  const meta = { expires_in: 900, limits };
  return batch ? { files, ...meta } : { ...files[0], ...meta };
}

// ---- Multipart (large files) ----
// For files over ~100 MB the admin panel should use this rather than one PUT, so
// a dropped connection costs one part, not the whole file. With a declared
// `size`, initiate returns the part plan and presign-parts signs each part for
// its exact length; the client must cut the file at `part_size` (the last part is
// the remainder) and send the same `size` back with each presign-parts call.
async function multipartInitiate({ target, filename, content_type, size }) {
  const limits = await uploadLimits.load('admin');
  const key    = buildKey(target, filename);
  const file   = checkFile({ target, filename, content_type, size }, limits);
  uploadLimits.assertBatch([file], limits);

  const upload_id = await s3.createMultipartUpload(key, content_type);
  return {
    key, upload_id, upload_method: 'multipart',
    ...(file.size != null ? partPlan(file.size) : {}),
  };
}

async function multipartPresignParts({ key, upload_id, part_numbers, size }) {
  assertAllowedKey(key);
  let plan = null;
  if (size != null) {
    const kind = kindForKey(key);
    if (kind) uploadLimits.assertFileSize({ kind, size, limits: await uploadLimits.load('admin'), at: (f) => f });
    plan = partPlan(size);
    const beyond = part_numbers.find((n) => n > plan.part_count);
    if (beyond) throw bad('part_numbers', `this upload has ${plan.part_count} part(s); part ${beyond} does not exist`);
  }
  const parts = await Promise.all(part_numbers.map(async (n) => ({
    part_number: n,
    url: await s3.presignUploadPart(key, upload_id, n, 3600, plan ? { contentLength: partLength(plan, n, size) } : {}),
    ...(plan ? { size: partLength(plan, n, size) } : {}),
  })));
  return { parts };
}

// The assembled object is checked once it exists: an upload whose parts were
// presigned without a size has had no size check until now.
async function multipartComplete({ key, upload_id, parts }) {
  assertAllowedKey(key);
  await s3.completeMultipartUpload(key, upload_id, parts);
  await assertStoredFileOk(key, await uploadLimits.load('admin'), 'key');
  return { key };
}

async function multipartAbort({ key, upload_id }) {
  assertAllowedKey(key);
  await s3.abortMultipartUpload(key, upload_id);
  return { key };
}

// ---- Promote pending -> active ----
//
// Reported PER KEY, matching the user-side endpoint. The tag flip happens as the
// loop goes, so throwing on the first bad key used to leave the earlier ones
// promoted with the caller seeing only a 400 — no way to tell which of a
// twenty-file bundle actually landed.
//
// When EVERY key fails the original error is rethrown, so a single-key confirm
// still gets the same 400 it always did.
//
// Each key is checked before its promotion (present, within its size cap, bytes
// matching its extension) — the backstop for uploads whose URL was not bound to
// a declared size.
async function confirm({ keys }) {
  const results  = [];
  const failures = [];
  const limits   = await uploadLimits.load('admin');

  for (const key of keys) {
    try {
      assertAllowedKey(key);
      await assertStoredFileOk(key, limits, 'keys');
      await s3.putObjectTagging(key, 'active');
      results.push({ key, status: 'confirmed' });
    } catch (err) {
      // Only a bad key is this key's own fault. An S3 or credentials failure is a
      // fault of ours and must surface as a 500, not as a per-file rejection the
      // caller would read as "that file was invalid".
      if (!err.isOperational) throw err;
      failures.push(err);
      results.push({ key, status: 'rejected', reason: uploadLimits.rejectionReason(err), code: err.errorCode });
    }
  }

  if (failures.length === keys.length && failures.length > 0) throw failures[0];

  return { keys: results.filter((r) => r.status === 'confirmed').map((r) => r.key), results };
}

module.exports = {
  buildKey, assertAllowedKey, IMAGE_SLOTS, ASSET_TYPES, ALLOWED_ROOTS, partPlan,
  presign, multipartInitiate, multipartPresignParts, multipartComplete, multipartAbort, confirm,
};
