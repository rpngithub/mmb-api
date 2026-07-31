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
  special_event_banner:        'events/banner',
  banner:                      'banners',
  testimonial:                 'testimonials',
};
const ASSET_TYPES = ['icon', 'emoji', 'shape', 'font', 'audio', 'video', 'animated', 'bg'];

// Any final key must live under one of these roots (re-validated on multipart complete/abort).
// 'themes/' is retained deliberately: thumbnails uploaded before the Brand Series rename
// still live there, and their stored keys must keep validating on re-save.
const ALLOWED_ROOTS = ['categories/', 'brand-series/', 'variants/', 'themes/', 'events/', 'banners/', 'testimonials/', 'assets/', 'templates/'];

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
async function presign({ target, filename, content_type }) {
  const key = buildKey(target, filename);
  const upload_url = await s3.getPresignedPutUrl(key, content_type);
  return { key, upload_url, required_headers: { 'x-amz-tagging': 'status=pending' }, expires_in: 900 };
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
async function confirm({ keys }) {
  for (const key of keys) {
    assertAllowedKey(key);
    await s3.putObjectTagging(key, 'active');
  }
  return { keys };
}

module.exports = {
  buildKey, assertAllowedKey, IMAGE_SLOTS, ASSET_TYPES, ALLOWED_ROOTS,
  presign, multipartInitiate, multipartPresignParts, multipartComplete, multipartAbort, confirm,
};
