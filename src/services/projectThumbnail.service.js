const crypto = require('crypto');
const s3     = require('../utils/s3Helper');
const { ValidationError } = require('../errors');

/**
 * Project thumbnails arrive INLINE on the save call, not through the presign flow.
 *
 * The presign → PUT → confirm → PATCH sequence exists for files the user brings
 * in: they can be large, they count against storage, and each one is a thing the
 * user later manages. A project thumbnail is none of that — it is a small preview
 * the editor renders itself, replaced on every autosave, and there is exactly one
 * per project. Pushing it through presign made every 2-second autosave four
 * round-trips and minted a new charged ledger row each time. Here it is one field
 * on the PATCH the editor already makes.
 *
 * Consequences, all deliberate:
 *   - Not charged to storage quota and not in the uploads ledger. It is a
 *     derivative of the project, not a stored file. Capped small enough that a
 *     user cannot use it as free storage.
 *   - The key carries a content hash, so a changed thumbnail is a NEW object and a
 *     CDN never serves the stale one; the previous object is deleted once the new
 *     one is written. An unchanged thumbnail (same hash) is a no-op.
 *   - Lives under users/<uid>/projects/<project uid>/ — inside the user's
 *     namespace, so the account purge sweeps it with everything else.
 */

// Big enough for a crisp card preview at any density; small enough that autosave
// payloads stay light and nobody stores their holiday photos in it.
const MAX_BYTES = 500 * 1024;

// The declared MIME in a data URL is whatever the client typed. The bytes decide.
const SIGNATURES = [
  { type: 'image/jpeg', ext: 'jpg',  match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png',  ext: 'png',  match: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/webp', ext: 'webp', match: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
];

const bad = (message) => new ValidationError('Invalid thumbnail', [{ field: 'thumbnail', message }]);

// Accepts `data:image/…;base64,<payload>` or the bare base64 payload. Returns the
// bytes and what they actually are.
function decode(input) {
  const str = String(input || '').trim();
  const payload = str.startsWith('data:') ? str.slice(str.indexOf(',') + 1) : str;
  if (!payload) throw bad('empty');

  // Base64 is 4/3 the size, so a quick pre-check keeps a huge string from being
  // decoded only to be rejected.
  if (payload.length > Math.ceil(MAX_BYTES * 4 / 3) + 4) {
    throw bad(`exceeds the ${MAX_BYTES / 1024} KB limit`);
  }

  const bytes = Buffer.from(payload, 'base64');
  if (!bytes.length) throw bad('not valid base64');
  if (bytes.length > MAX_BYTES) throw bad(`exceeds the ${MAX_BYTES / 1024} KB limit`);

  const sig = SIGNATURES.find((s) => s.match(bytes));
  if (!sig) throw bad('must be a JPEG, PNG or WebP image');
  return { bytes, ...sig };
}

const keyFor = (userUid, projectUid, hash, ext) => `users/${userUid}/projects/${projectUid}/thumb-${hash}.${ext}`;

/**
 * Stores the thumbnail and returns the key to save on the project — or the
 * current key, unchanged, when the bytes are identical to what is already there.
 * The caller persists the key; this only handles the object.
 */
async function store(input, { userUid, projectUid, currentKey }) {
  const { bytes, type, ext } = decode(input);
  const hash = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12);
  const key  = keyFor(userUid, projectUid, hash, ext);
  if (key === currentKey) return key;

  await s3.uploadFile(key, bytes, type);

  // Only our own previous thumbnail is cleaned up. A key from anywhere else (an
  // older scheme, a hand-set value) is left alone rather than deleted on a guess.
  if (currentKey && currentKey.startsWith(`users/${userUid}/projects/${projectUid}/`)) {
    try { await s3.deleteFile(currentKey); } catch (err) {
      // Leaving one orphaned preview behind is not worth failing the user's save.
      console.warn(`[ProjectThumbnail] could not delete replaced ${currentKey}: ${err.message}`);
    }
  }
  return key;
}

module.exports = { store, decode, MAX_BYTES };
