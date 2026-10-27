const { v4: uuid } = require('uuid');
const s3           = require('../utils/s3Helper');
const userRepo     = require('../repositories/user.repository');
const quota        = require('./quota.service');
const uploadLimits = require('./uploadLimits.service');
const projectThumbnail = require('./projectThumbnail.service');
const { kindOfType } = require('../constants/uploadTypes');
const { UserUpload } = require('../models');
const { ValidationError, NotFoundError, QuotaError } = require('../errors');

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
  // NOTE: there was a `user_frame` slot here. Frames are now admin-authored
  // catalogue content that users buy or add (see services/frame.service.js), not
  // files a user uploads, so the slot is retired — presigning one is rejected.
  // Migration 20260101000028 refunded the storage the old uploads were holding.
  // "My Uploads" — the images and videos a user brings into the editor. Unlike
  // the slots above, these are not saved onto a record: the upload IS the thing,
  // so the ledger row is what the library lists.
  media_library:  'media',
  // A font file for the user's own Brand Kit typeface. The only non-image slot.
  brand_font:     'fonts',
};

// What "My Uploads" shows by default. The other slots are managed on their own
// screens (a logo is changed on the business profile), and listing them here
// would invite someone to delete their logo from a media grid.
const DEFAULT_LIST_SLOT = 'media_library';

// Image and video types come from app_settings (`upload_user_image_types`,
// `upload_user_video_types`, see uploadLimits.service), and so do the size and
// count limits. SVG can never be switched on for users — the settings rule
// refuses it, since it can carry script and these files are served to browsers.
//
// Video goes to the media library ONLY. Every other image slot saves its key onto
// a record that is drawn as an image (a logo, a cover, a product photo); taking
// video there is a display change on every client, not an upload change.
const VIDEO_SLOTS = new Set(['media_library']);

const allowedTypesFor = (slotName, limits) => [
  ...limits.image.types,
  ...(VIDEO_SLOTS.has(slotName) ? limits.video.types : []),
];

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
// Fonts keep their own fixed cap; the upload settings cover images and video.
const FONT_MAX_BYTES = 10 * 1024 * 1024;

const bad = (field, message) => new ValidationError('Validation failed', [{ field, message }]);

const { ext, toMb } = uploadLimits;

const prefixFor = (userUid, slot) => `users/${userUid}/${slot}/`;

async function userUidFor(userId) {
  const user = await userRepo.findById(userId, { attributes: ['uid'] });
  if (!user) throw new NotFoundError('User not found');
  return user.uid;
}

// ---- Presign (single PUT) ----
// No multipart on the user side: a single presigned PUT covers 5 GB and the video
// cap is far below that. Every file reports `upload_method: "single"` so the
// server can start answering "multipart" for large files later without breaking
// a client that reads the field.
//
// Sizes. A client that sends each file's `size` (bytes) gets it checked HERE —
// per file, per request, and against remaining storage — and gets a URL bound to
// exactly that length and content type, so S3 itself refuses anything else.
// `size` is optional for now because older app builds do not send it; they get
// today's unbound URL and the size check at confirm only. Make it required once
// min_supported_version passes the first build that sends it.
//
// Two request shapes, and the response mirrors whichever was sent. The original
// single-file body returns its fields flat, exactly as it always has; a batch
// (`files: [...]`) returns a `files` array plus the limits, which are per-account
// and so are reported once rather than repeated N times.
//
// Batching matters beyond the round trips: the quota check and the uid lookup are
// per-ACCOUNT, and issuing 20 keys one request at a time ran both 20 times.
async function presign(body, userId) {
  const batch = Array.isArray(body.files);
  const items = batch ? body.files : [body];

  // Validate every item BEFORE issuing any URL, so a batch with one bad file is
  // rejected whole instead of half-signed. Nothing has been uploaded at this
  // point, so there is nothing to unwind — and the field path names the offender.
  // Dot-indexed to match the paths Joi produces (`files.3.content_type`), so a
  // client sees one convention whether the rejection came from the schema or here.
  const at = (i, field) => (batch ? `files.${i}.${field}` : field);
  const limits = await uploadLimits.load('user');

  const checked = items.map(({ target, filename, content_type, size }, i) => {
    const field    = (f) => at(i, f);
    const slotName = target && target.slot;
    if (!SLOTS[slotName]) throw bad(field('target.slot'), `slot must be one of: ${Object.keys(SLOTS).join(', ')}`);
    const declared = size == null ? null : Number(size);

    // Rules are per slot: an image slot must not accept a font, and vice versa.
    if (slotName === 'brand_font') {
      if (content_type && !FONT_CONTENT_TYPES.includes(content_type)) {
        throw bad(field('content_type'), `content_type must be one of: ${FONT_CONTENT_TYPES.join(', ')}`);
      }
      if (!FONT_EXTENSIONS.includes(ext(filename))) {
        throw bad(field('filename'), `file must be one of: ${FONT_EXTENSIONS.map((e) => `.${e}`).join(', ')}`);
      }
      if (declared != null && declared > FONT_MAX_BYTES) {
        throw bad(field('size'), `file is ${toMb(declared)} MB; the limit for fonts is ${toMb(FONT_MAX_BYTES)} MB`);
      }
      return { slotName, filename, content_type, kind: 'font', size: declared };
    }

    const type = uploadLimits.resolveType({
      declared: content_type, filename, allowed: allowedTypesFor(slotName, limits), at: field,
    });
    const kind = kindOfType(type);
    uploadLimits.assertFileSize({ kind, size: declared, limits, at: field });
    return { slotName, filename, content_type, kind, size: declared };
  });

  // Count and combined size are per REQUEST. Over either, the whole request is
  // refused even when every file passes on its own.
  const total = uploadLimits.assertBatch(checked, limits);

  // Fail before the client wastes a round trip uploading into a full account.
  // When every file declared its size, the whole request must fit; otherwise this
  // can only ask "is there any room at all". The charge itself still happens at
  // confirm, file by file, once S3 reports the real size — nothing is reserved,
  // so two requests racing for the last megabytes are settled there.
  if (checked.every((c) => c.size != null)) {
    const left = await quota.remaining(userId, 'storage');
    if (left !== null && total > left) {
      throw new QuotaError(`Selected files total ${toMb(total)} MB, but only ${toMb(left)} MB of storage is left. Upgrade your plan or buy a top-up.`);
    }
  } else {
    await quota.assertWithinQuota(userId, 'storage');
  }

  const userUid = await userUidFor(userId);
  const files   = await Promise.all(checked.map(async (c) => {
    const key   = `${prefixFor(userUid, SLOTS[c.slotName])}${uuid()}.${ext(c.filename)}`;
    const bound = c.size != null;
    return {
      key,
      upload_url:       await s3.getPresignedPutUrl(key, c.content_type, bound ? { contentLength: c.size } : {}),
      // A bound URL also signs Content-Type, so the PUT must send exactly the
      // declared one. Content-Length is set by the HTTP client from the body.
      required_headers: {
        'x-amz-tagging': 'status=pending',
        ...(bound && c.content_type ? { 'Content-Type': c.content_type } : {}),
      },
      upload_method:    'single',
    };
  }));

  const meta = {
    expires_in:        900,
    // The image cap, kept for clients that read it; `limits` has the full set.
    max_bytes:         limits.image.max_bytes,
    // Headroom left in the plan. null = unlimited (or an unenforced account).
    storage_remaining: await quota.remaining(userId, 'storage'),
    limits,
  };

  return batch ? { files, ...meta } : { ...files[0], ...meta };
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
//
// Reported PER KEY rather than by throwing on the first bad one. That distinction
// only shows up in a batch, but there it is the whole point: the loop promotes and
// charges as it goes, so throwing halfway used to leave the earlier keys active,
// already billed, and invisible to a client that saw nothing but a 400.
//
// The all-or-nothing alternative would mean rolling back promotions and quota on
// failure, and one oversized file in a set of twenty is a routine thing, not an
// error worth discarding nineteen good uploads over.
//
// When EVERY item fails the original error is rethrown, so a single-key confirm —
// which is every existing caller — still gets the same 400/402 it always did.
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
  const limits  = await uploadLimits.load('user');

  const results  = [];
  const failures = [];

  for (const item of items) {
    try {
      await promoteOne(item, { userId, userUid, mine, slotOf, limits });
      results.push({ key: item.key, status: 'confirmed' });
    } catch (err) {
      if (!err.isOperational) throw err;      // a real fault, not this file's fault
      failures.push(err);
      results.push({ key: item.key, status: 'rejected', reason: uploadLimits.rejectionReason(err), code: err.errorCode });
    }
  }

  // Nothing got through: there is no partial success to report, so fail the
  // request exactly as before rather than returning a 200 full of rejections.
  if (failures.length === items.length && failures.length > 0) throw failures[0];

  // `keys` is kept for the clients that read it, but now lists only what was
  // actually promoted — a rejected key must never reach a record's s3_key column.
  return { keys: results.filter((r) => r.status === 'confirmed').map((r) => r.key), results };
}

// Promotes one uploaded object, or throws an operational error describing why it
// could not be. Split out of confirm so each key's failure is catchable on its own.
async function promoteOne(item, { userId, userUid, mine, slotOf, limits }) {
  const key = item.key;
  if (!key.startsWith(mine)) throw bad('keys', 'key is outside your upload namespace');

  // Already confirmed: promoting again must not charge again. The unique index
  // on s3_key is the backstop; this keeps a retry from erroring.
  if (await UserUpload.findOne({ where: { s3_key: key }, attributes: ['id'] })) return;

  // What the file must be. The key's extension was checked against the type at
  // presign, so it is the authority here — not the Content-Type the PUT sent.
  const slotName = slotOf[key.slice(mine.length).split('/')[0]] || 'unknown';
  const isFont   = slotName === 'brand_font';
  const type     = isFont ? null : uploadLimits.typeOfKey(key);
  const kind     = isFont ? 'font' : kindOfType(type);
  const maxBytes = isFont ? FONT_MAX_BYTES : (limits[kind] || limits.image).max_bytes;

  // Video metadata is decoded BEFORE anything destructive: a bad poster fails
  // this one file and leaves the upload pending, so the client can retry the
  // confirm with a corrected poster instead of uploading the video again.
  const hasVideoMeta = item.poster != null || item.duration_ms != null;
  if (hasVideoMeta && kind !== 'video') throw bad('uploads', 'duration_ms and poster are only accepted for videos');
  const poster = item.poster ? projectThumbnail.decode(item.poster, { field: 'poster' }) : null;

  // HEAD returns null when it cannot tell (no bucket wired up, or a 403 that is
  // indistinguishable from a missing object) — treat that as inconclusive and
  // let the promotion through rather than rejecting a legitimate upload. The
  // ledger then records 0 bytes: an unmeasurable object is not charged, which
  // is the safe direction to be wrong in.
  const head = await s3.objectExists(key);
  if (head && head.exists === false) throw bad('keys', `no uploaded object found at ${key}`);

  // The backstop for every size check presign made: a URL bound to a declared
  // size cannot carry more, but an older client's unbound URL can.
  const bytes = (head && head.size != null) ? Number(head.size) : 0;
  if (bytes > maxBytes) {
    await s3.deleteFile(key);
    throw bad('keys', `file exceeds the ${toMb(maxBytes)} MB limit`);
  }

  // The bytes must be what the extension says. A short ranged read; when it
  // cannot be made (no bucket, permissions) it is inconclusive and the file goes
  // through, the same call the HEAD above makes.
  if (head && type && uploadLimits.hasSignature(type)) {
    const start = await s3.readObjectStart(key, uploadLimits.SNIFF_BYTES);
    if (start && !uploadLimits.matchesSignature(type, start)) {
      await s3.deleteFile(key);
      throw bad('keys', `file content is not a valid ${type} file`);
    }
  }

  // Over plan storage: delete rather than promote, so a rejected file leaves
  // nothing behind to be referenced or paid for. In a batch this is also what
  // stops the rest of the set from being abandoned untagged — each file is
  // charged as it lands, so the first one that does not fit is the only casualty.
  try {
    await quota.assertWithinQuota(userId, 'storage', bytes);
  } catch (err) {
    await s3.deleteFile(key);
    throw err;
  }

  // The poster is written before the promotion, so a storage failure here leaves
  // the video pending and uncharged rather than active without its grid image.
  // Outside the ledger and the quota, like a project thumbnail; under the user's
  // prefix, so the account purge sweeps it.
  const uploadUid = uuid();
  let posterKey = null;
  if (poster) {
    posterKey = `users/${userUid}/posters/${uploadUid}.${poster.ext}`;
    await s3.uploadFile(posterKey, poster.bytes, poster.type);
  }

  await s3.putObjectTagging(key, 'active');
  await UserUpload.create({
    uid:          uploadUid,
    user_id:      userId,
    s3_key:       key,
    slot:         slotName,
    bytes,
    content_type: (head && head.content_type) || type || null,
    width:             posIntOrNull(item.width),
    height:            posIntOrNull(item.height),
    original_filename: item.filename ? String(item.filename).slice(0, 255) : null,
    duration_ms:       posIntOrNull(item.duration_ms),
    poster_s3_key:     posterKey,
  });
  await quota.consume(userId, 'storage', bytes, { source: 'upload', ref_type: 'user_upload' });
}

const posIntOrNull = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// ---- Storage allowance ----
// The same numbers presign returns, without having to start an upload to see
// them. Everything is in BYTES on purpose: `/subscriptions/me` reports storage in
// MB (its features list renders against a plan label, and the limit is stored in
// MB), which is the wrong unit to compare a File.size against. A client sizing a
// batch should read this, not that.
//
// null limit/remaining = unlimited, or a free account where the limit is recorded
// but not enforced. `used_bytes` is real either way.
async function storageQuota(userId) {
  const { limit, used, remaining, topup_granted } = await quota.snapshot(userId, 'storage');
  const limits = await uploadLimits.load('user');
  return {
    limit_bytes:      limit,
    used_bytes:       used,
    remaining_bytes:  remaining,
    // Purchased capacity, already included in `remaining`. Reported separately so
    // a client can say "100 MB plan + 500 MB bought" rather than one opaque total.
    topup_bytes:      topup_granted,
    unlimited:        limit === null,
    // The image cap, kept for clients that read it; `upload_limits` has the
    // per-kind sizes, counts, request total and allowed types.
    max_upload_bytes: limits.image.max_bytes,
    upload_limits:    limits,
  };
}

// ---- "My Uploads" library ----

// What a client sees of an upload. `id` and `user_id` stay internal; `s3_key` is
// what the app prepends cdn_base_url to.
const LIBRARY_ATTRS = [
  'uid', 's3_key', 'slot', 'bytes', 'content_type', 'width', 'height', 'original_filename',
  'duration_ms', 'poster_s3_key', 'created_at',
];

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
  // The poster goes with its video. Best-effort: it is uncharged, and the account
  // purge sweeps the prefix anyway.
  if (row.poster_s3_key) {
    try { await s3.deleteFile(row.poster_s3_key); } catch (err) {
      console.warn(`[UserUpload] could not delete poster ${row.poster_s3_key}: ${err.message}`);
    }
  }
  await row.destroy();
  await quota.release(userId, 'storage', Number(row.bytes), { source: 'upload', ref_type: 'user_upload' });
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
  presign, confirm, assertOwnedKey, release, releaseReplaced, listMine, deleteMine, storageQuota,
  SLOTS, VIDEO_SLOTS, FONT_MAX_BYTES, DEFAULT_LIST_SLOT,
};
