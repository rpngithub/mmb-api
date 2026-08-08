const { v4: uuid } = require('uuid');
const s3           = require('../utils/s3Helper');
const userRepo     = require('../repositories/user.repository');
const quota        = require('./quota.service');
const { UserUpload } = require('../models');
const { ValidationError, NotFoundError } = require('../errors');

// ---- User-facing direct-to-S3 uploads ----
//
// Same Design B as the admin side (presign straight to the FINAL key tagged
// status=pending, then a tag flip on confirm), with one difference that carries
// the whole security model: EVERY key is derived from the authenticated caller
// and lives under `users/<their uid>/`. The client never supplies a key or a
// prefix, only a slot name.
//
// That namespacing is what makes the write paths safe. Products, frames, logos
// and profile photos are all saved by handing the server an `s3_key`, and before
// this existed any string was accepted — a user could point their product image
// at another user's upload or at a premium admin asset. Now every one of those
// writes runs assertOwnedKey, and a key outside the caller's own prefix is one
// the server never issued to them.
//
// Everything is scoped to the USER rather than the business on purpose: the logo
// is uploaded on the business-details screen BEFORE the business row exists, so a
// business-scoped prefix could not be derived yet. One business per user makes
// the two equivalent for ownership anyway.

const SLOTS = {
  profile_photo:  'profile',
  business_logo:  'logo',
  business_cover: 'cover',
  product_image:  'products',
  user_frame:     'frames',
  // "My Uploads" — the images a user brings into the editor. Unlike the slots
  // above, these are not saved onto a record: the upload IS the thing, so the
  // ledger row is what the library lists.
  media_library:  'media',
  // A font file for the user's own Brand Kit typeface. The only non-image slot.
  brand_font:     'fonts',
};

// What "My Uploads" shows by default. The other slots are managed on their own
// screens (a logo is changed on the business profile), and listing them here
// would invite someone to delete their logo from a media grid.
const DEFAULT_LIST_SLOT = 'media_library';

// Raster images only. SVG is deliberately excluded for user uploads (it can carry
// script and these files are served back to browsers); admins can still upload SVG
// icons through the admin endpoints, where the uploader is trusted.
const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Font uploads are the one non-image slot. Browsers are famously inconsistent
// about font MIME types — the same .woff2 arrives as font/woff2,
// application/font-woff2 or application/octet-stream depending on the OS — so the
// content type alone cannot be trusted here and the EXTENSION is checked as well.
const FONT_CONTENT_TYPES = [
  'font/woff2', 'font/woff', 'font/ttf', 'font/otf', 'font/sfnt',
  'application/font-woff', 'application/font-woff2', 'application/x-font-ttf',
  'application/x-font-otf', 'application/octet-stream',
];
const FONT_EXTENSIONS = ['woff2', 'woff', 'ttf', 'otf'];

// Per-slot rules; everything not listed is an image slot.
const SLOT_RULES = {
  brand_font: { types: FONT_CONTENT_TYPES, extensions: FONT_EXTENSIONS },
};
const rulesFor = (slotName) => SLOT_RULES[slotName] || { types: IMAGE_CONTENT_TYPES, extensions: null };

// Kept for the validator, which advertises what a client may send. The font types
// are additionally constrained by extension, so the union is safe to expose.
const ALLOWED_CONTENT_TYPES = [...IMAGE_CONTENT_TYPES, ...FONT_CONTENT_TYPES];

// Checked at confirm, which is the only point a presigned PUT can be policed —
// the URL itself cannot carry a size condition. An oversized object is deleted
// rather than promoted, so its key can never be saved onto a record.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const bad = (field, message) => new ValidationError('Validation failed', [{ field, message }]);

const ext = (filename) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : 'bin';
};

const prefixFor = (userUid, slot) => `users/${userUid}/${slot}/`;

async function userUidFor(userId) {
  const user = await userRepo.findById(userId, { attributes: ['uid'] });
  if (!user) throw new NotFoundError('User not found');
  return user.uid;
}

// ---- Presign (single PUT) ----
// No multipart on the user side: every slot here is an image, and a single
// presigned PUT covers files far larger than MAX_UPLOAD_BYTES. Add multipart when
// a slot starts taking video.
async function presign({ target, filename, content_type }, userId) {
  const slotName = target && target.slot;
  const slot     = SLOTS[slotName];
  if (!slot) throw bad('target.slot', `slot must be one of: ${Object.keys(SLOTS).join(', ')}`);

  // Rules are per slot: an image slot must not accept a font, and vice versa.
  const rules = rulesFor(slotName);
  if (content_type && !rules.types.includes(content_type)) {
    throw bad('content_type', `content_type must be one of: ${rules.types.join(', ')}`);
  }
  if (rules.extensions && !rules.extensions.includes(ext(filename))) {
    throw bad('filename', `file must be one of: ${rules.extensions.map((e) => `.${e}`).join(', ')}`);
  }

  // Fail before the client wastes a round trip uploading into a full account.
  // The real charge happens at confirm, once the byte count is known.
  await quota.assertWithinQuota(userId, 'storage');

  const key = `${prefixFor(await userUidFor(userId), slot)}${uuid()}.${ext(filename)}`;
  const upload_url = await s3.getPresignedPutUrl(key, content_type);

  // Headroom left in the plan, so the client can reject an oversized file before
  // uploading it. null = unlimited (or an unenforced free account).
  const storageRemaining = await quota.remaining(userId, 'storage');

  return {
    key,
    upload_url,
    required_headers:  { 'x-amz-tagging': 'status=pending' },
    expires_in:        900,
    max_bytes:         MAX_UPLOAD_BYTES,
    storage_remaining: storageRemaining,
  };
}

// ---- Confirm: promote pending -> active, and charge storage ----
// Re-derives the caller's prefix rather than trusting the key, so confirm cannot
// be used to flip somebody else's object (or an admin asset) to active.
//
// This is where storage is charged, because it is the first point the byte count
// is known (a presigned PUT reports nothing back to us) and because confirming is
// the user saying "keep this file". Charging later — when the key is saved onto a
// record — would leave confirmed-but-unattached objects free AND unswept: the
// lifecycle rule only collects objects still tagged pending.
async function confirm(body, userId) {
  // Two accepted shapes. `keys: ["…"]` is the original and still works; `uploads:
  // [{ key, width, height, filename }]` carries the grid metadata the media
  // library needs, which the server cannot derive (reading image dimensions would
  // mean decoding the file).
  const items = Array.isArray(body.uploads)
    ? body.uploads
    : (body.keys || []).map((key) => ({ key }));

  const slotOf  = Object.fromEntries(Object.entries(SLOTS).map(([target, slot]) => [slot, target]));
  const userUid = await userUidFor(userId);
  const mine    = `users/${userUid}/`;
  const keys    = items.map((i) => i.key);

  for (const item of items) {
    const key = item.key;
    if (!key.startsWith(mine)) throw bad('keys', 'key is outside your upload namespace');

    // Already confirmed: promoting again must not charge again. The unique index
    // on s3_key is the backstop; this keeps a retry from erroring.
    if (await UserUpload.findOne({ where: { s3_key: key }, attributes: ['id'] })) continue;

    // HEAD returns null when it cannot tell (no bucket wired up, or a 403 that is
    // indistinguishable from a missing object) — treat that as inconclusive and
    // let the promotion through rather than rejecting a legitimate upload. The
    // ledger then records 0 bytes: an unmeasurable object is not charged, which
    // is the safe direction to be wrong in.
    const head = await s3.objectExists(key);
    if (head && head.exists === false) throw bad('keys', `no uploaded object found at ${key}`);

    const bytes = (head && head.size != null) ? Number(head.size) : 0;
    if (bytes > MAX_UPLOAD_BYTES) {
      await s3.deleteFile(key);
      throw bad('keys', `file exceeds the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit`);
    }

    // Over plan storage: delete rather than promote, so a rejected file leaves
    // nothing behind to be referenced or paid for.
    try {
      await quota.assertWithinQuota(userId, 'storage', bytes);
    } catch (err) {
      await s3.deleteFile(key);
      throw err;
    }

    await s3.putObjectTagging(key, 'active');
    await UserUpload.create({
      uid:          uuid(),
      user_id:      userId,
      s3_key:       key,
      slot:         slotOf[key.slice(mine.length).split('/')[0]] || 'unknown',
      bytes,
      content_type: (head && head.content_type) || null,
      width:             posIntOrNull(item.width),
      height:            posIntOrNull(item.height),
      original_filename: item.filename ? String(item.filename).slice(0, 255) : null,
    });
    await quota.consume(userId, 'storage', bytes);
  }
  return { keys };
}

const posIntOrNull = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// ---- "My Uploads" library ----

// What a client sees of an upload. `id` and `user_id` stay internal; `s3_key` is
// what the app prepends cdn_base_url to.
const LIBRARY_ATTRS = ['uid', 's3_key', 'slot', 'bytes', 'content_type', 'width', 'height', 'original_filename', 'created_at'];

async function listMine(userId, { slot, limit, offset } = {}) {
  const wanted = slot && SLOTS[slot] ? slot : DEFAULT_LIST_SLOT;
  return UserUpload.findAndCountAll({
    where:      { user_id: userId, slot: wanted },
    attributes: LIBRARY_ATTRS,
    order:      [['id', 'DESC']],          // newest first
    limit:      Math.min(parseInt(limit, 10) || 50, 100),
    offset:     Math.max(parseInt(offset, 10) || 0, 0),
  });
}

// Deletes the file and refunds its storage. Owner-scoped by the lookup itself, so
// another user's uid is a 404 rather than a 403 — there is nothing to tell them.
//
// NOTE: a design that used this image will render it broken. Nothing links a
// project to its uploads (project content is an opaque JSON blob), so that cannot
// be detected here — the app should warn before calling this.
async function deleteMine(uid, userId) {
  const row = await UserUpload.findOne({ where: { uid, user_id: userId } });
  if (!row) throw new NotFoundError('Upload not found');
  await release(row.s3_key, userId);
}

// ---- Release: the user deleted the thing the file belonged to ----
// Deletes the object and gives its bytes back, reading the charged amount off the
// ledger instead of re-measuring — a HEAD here would fail exactly when it matters
// (object already gone, credentials expired) and every failure would drift the
// counter upward permanently.
//
// A key with NO ledger row is left completely alone: we never charged for it, so
// there is nothing to refund, and it is not an object this service is managing
// (uploaded before the ledger existed, or never confirmed and therefore due to be
// swept as pending). Deleting it here would be acting on a file we know nothing
// about.
//
// Deliberately best-effort at the CALLER's discretion: it runs after the record is
// gone, so a storage hiccup cannot block a user from deleting their own content.
async function release(key, userId) {
  if (!key) return;
  const row = await UserUpload.findOne({ where: { s3_key: key, user_id: userId } });
  if (!row) return;

  await s3.deleteFile(key);
  await row.destroy();
  await quota.release(userId, 'storage', Number(row.bytes));
}

// Convenience for a field swap: release the old file when it is actually being
// replaced or cleared. A no-op when the value is unchanged or absent.
async function releaseReplaced(previousKey, nextKey, userId) {
  if (previousKey && nextKey !== undefined && nextKey !== previousKey) {
    await release(previousKey, userId);
  }
}

// ---- Write-path guard ----
// Called by every service that accepts an s3_key from a user. `slot` pins the key
// to the right kind of upload too, so a product image cannot be saved as a logo.
// Returns the value to store: null for a clear (both null and '' mean "remove the
// image", normalised here so the column never holds an empty string), otherwise
// the key itself.
async function assertOwnedKey(key, slotName, userId) {
  if (key === undefined) return undefined;
  if (key === null || key === '') return null;

  const slot = SLOTS[slotName];
  if (!slot) throw new Error(`unknown upload slot: ${slotName}`);   // programmer error, not user input

  const expected = prefixFor(await userUidFor(userId), slot);
  if (typeof key !== 'string' || !key.startsWith(expected)) {
    throw bad('s3_key', 's3_key was not issued to you for this kind of upload');
  }
  return key;
}

module.exports = {
  presign, confirm, assertOwnedKey, release, releaseReplaced, listMine, deleteMine,
  SLOTS, ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES, DEFAULT_LIST_SLOT,
};
