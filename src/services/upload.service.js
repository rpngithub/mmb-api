const { v4: uuid } = require('uuid');
const s3 = require('../utils/s3Helper');
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
  banner:                      'banners',
  testimonial:                 'testimonials',
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
const ALLOWED_ROOTS = ['categories/', 'brand-series/', 'variants/', 'themes/', 'events/', 'banners/', 'testimonials/', 'assets/', 'templates/', 'fonts/', 'frames/'];

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

// ---- Single-PUT (small files) ----
//
// One file (`target` + `filename`) or a batch (`files: [...]`), and the response
// mirrors whichever was sent — flat for one, a `files` array for a batch. Same
// shape as the user-side endpoint, so a client that already speaks one speaks
// both.
//
// Targets may be mixed within a batch: uploading a category icon and its
// thumbnail together is the common case, and they are different slots.
async function presign(body) {
  const batch = Array.isArray(body.files);
  const items = batch ? body.files : [body];

  // buildKey validates as it derives, so mapping it over every item first means a
  // batch with one bad target is rejected before ANY URL is issued. Nothing has
  // been uploaded at that point, so there is nothing to unwind.
  const keys = items.map(({ target, filename }, i) => {
    try {
      return buildKey(target, filename);
    } catch (err) {
      // Re-point the field at the offending entry, dot-indexed to match Joi.
      if (batch && err.details) {
        err.details = err.details.map((d) => ({ ...d, field: `files.${i}.${d.field}` }));
      }
      throw err;
    }
  });

  const files = await Promise.all(keys.map(async (key, i) => ({
    key,
    upload_url:       await s3.getPresignedPutUrl(key, items[i].content_type),
    required_headers: { 'x-amz-tagging': 'status=pending' },
  })));

  return batch ? { files, expires_in: 900 } : { ...files[0], expires_in: 900 };
}

// ---- Multipart (large files) ----
async function multipartInitiate({ target, filename, content_type }) {
  const key = buildKey(target, filename);
  const upload_id = await s3.createMultipartUpload(key, content_type);
  return { key, upload_id };
}

async function multipartPresignParts({ key, upload_id, part_numbers }) {
  assertAllowedKey(key);
  const parts = await Promise.all(
    part_numbers.map(async (n) => ({ part_number: n, url: await s3.presignUploadPart(key, upload_id, n) })),
  );
  return { parts };
}

async function multipartComplete({ key, upload_id, parts }) {
  assertAllowedKey(key);
  await s3.completeMultipartUpload(key, upload_id, parts);
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
async function confirm({ keys }) {
  const results  = [];
  const failures = [];

  for (const key of keys) {
    try {
      assertAllowedKey(key);
      await s3.putObjectTagging(key, 'active');
      results.push({ key, status: 'confirmed' });
    } catch (err) {
      // Only a bad key is this key's own fault. An S3 or credentials failure is a
      // fault of ours and must surface as a 500, not as a per-file rejection the
      // caller would read as "that file was invalid".
      if (!err.isOperational) throw err;
      failures.push(err);
      results.push({ key, status: 'rejected', reason: err.message, code: err.errorCode });
    }
  }

  if (failures.length === keys.length && failures.length > 0) throw failures[0];

  return { keys: results.filter((r) => r.status === 'confirmed').map((r) => r.key), results };
}

module.exports = {
  buildKey, assertAllowedKey, IMAGE_SLOTS, ASSET_TYPES, ALLOWED_ROOTS,
  presign, multipartInitiate, multipartPresignParts, multipartComplete, multipartAbort, confirm,
};
