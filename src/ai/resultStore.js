const s3 = require('../utils/s3Helper');
const http = require('./http');
const { INTERNAL, ProviderError } = require('./errors');

// Copies a finished job's files into OUR storage, at once. Provider result URLs
// expire in minutes (Magnific: 30, background removal: 5), so the app is never
// handed one — it gets our S3 key, and the file appears in the user's media
// library (slot `ai_result`, prefix users/<uid>/ai/).
//
// Images and audio (WAV, MP3). Audio gets its duration from the file itself.
//
// Storage IS charged (ledger source `ai_result`) but NOT enforced: the user has
// already paid credits for this result, and throwing it away because their
// storage is full would be the worst possible outcome. They see the usage and can
// free space afterwards.
//
// A file the adapter marks `require_alpha: true` must be a PNG or WEBP that can
// hold transparency (a background-removal result); anything else fails the job
// as TASK_FAILED (refunded) instead of handing the user a solid background.
//
// Idempotent per file: the key is derived from the job, so a finalize that runs
// twice finds its own row and reuses it.

const SLOT_NAME = 'ai_result';
const SLOT_DIR  = 'ai';

const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'audio/wav': 'wav', 'audio/mpeg': 'mp3',
};

// What the bytes actually are — never the provider's declared type.
function sniff(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && bytes[1] !== 0xff) return 'audio/mpeg';
  const head = bytes.slice(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

// SVG is served to browsers, so it must not carry script.
function assertSafeSvg(bytes) {
  const s = bytes.toString('utf8').toLowerCase();
  if (/<script|\son[a-z]+\s*=|javascript:|<foreignobject/.test(s)) {
    throw new ProviderError(INTERNAL.RESULT_FETCH_FAILED, 'after_start', { detail: 'unsafe svg refused' });
  }
}

function pngSize(bytes) {
  if (bytes.length < 24) return {};
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Can this image hold transparency? PNG: colour type 4 (grey + alpha) or 6
// (RGBA), or a tRNS chunk. WEBP: lossless (VP8L, alpha in the format) or extended
// with the alpha flag. JPEG never.
function hasAlpha(bytes, mime) {
  if (mime === 'image/png') {
    if (bytes.length < 26) return false;
    const colourType = bytes[25];
    if (colourType === 4 || colourType === 6) return true;
    for (let at = 8; at + 8 <= bytes.length;) {
      const len = bytes.readUInt32BE(at);
      const type = bytes.toString('ascii', at + 4, at + 8);
      if (type === 'tRNS') return true;
      if (type === 'IDAT' || type === 'IEND') return false;   // tRNS must come before IDAT
      at += 12 + len;
    }
    return false;
  }
  if (mime === 'image/webp') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8L') return true;
    if (chunk === 'VP8X') return bytes.length > 20 && (bytes[20] & 0x10) !== 0;
    return false;
  }
  return false;
}

// WAV duration from its own header: data size / byte rate. Walks the chunks, so
// extra chunks (LIST, fact) before `data` are fine. MP3: unknown (null).
function audioDurationMs(bytes, mime) {
  if (mime !== 'audio/wav' || bytes.length < 12) return null;
  let byteRate = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 20 <= bytes.length) byteRate = bytes.readUInt32LE(at + 16);
    if (id === 'data') {
      const dataBytes = Math.min(size, bytes.length - at - 8);
      return byteRate ? Math.round((dataBytes / byteRate) * 1000) : null;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/**
 * @param job      ai_jobs row (needs id, uid, user_id, operation_key)
 * @param files    [{ buffer } | { url }, require_alpha?] from the adapter
 * @param adapter  for its allowedHosts
 * @returns [{ media_uid, s3_key, mime, width, height, duration_ms, bytes }]
 */
async function store(job, files, adapter) {
  const { UserUpload, User } = require('../models');
  const quota = require('../services/quota.service');

  const user = await User.findByPk(job.user_id, { attributes: ['id', 'uid'] });
  if (!user) throw new ProviderError(INTERNAL.UNKNOWN, 'after_start', { detail: 'job owner no longer exists' });
  if (!files || !files.length) throw new ProviderError(INTERNAL.TASK_FAILED, 'after_start', { detail: 'provider returned no files' });

  const out = [];
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const bytes = f.buffer
      ? Buffer.from(f.buffer)
      : (await http.download(f.url, { allowedHosts: adapter.allowedHosts })).bytes;

    const mime = sniff(bytes);
    if (!mime) throw new ProviderError(INTERNAL.RESULT_FETCH_FAILED, 'after_start', { detail: 'result is not a supported image or audio file' });
    if (mime === 'image/svg+xml') assertSafeSvg(bytes);
    if (f.require_alpha && !hasAlpha(bytes, mime)) {
      throw new ProviderError(INTERNAL.TASK_FAILED, 'after_start', { detail: `result has no transparent background (${mime})` });
    }

    const key = `users/${user.uid}/${SLOT_DIR}/${job.uid}/${i + 1}.${EXT[mime]}`;
    let row = await UserUpload.findOne({ where: { s3_key: key } });
    if (!row) {
      await s3.uploadFile(key, bytes, mime);
      const dims = mime === 'image/png' ? pngSize(bytes) : {};
      row = await UserUpload.create({
        user_id: user.id, s3_key: key, slot: SLOT_NAME, bytes: bytes.length, content_type: mime,
        width: dims.width || null, height: dims.height || null,
        duration_ms: audioDurationMs(bytes, mime),
        original_filename: `${job.operation_key}-${i + 1}.${EXT[mime]}`,
      });
      await quota.consume(user.id, 'storage', bytes.length, { source: 'ai_result', ref_type: 'user_upload', ref_id: row.id });
    }
    out.push({
      media_uid: row.uid, s3_key: row.s3_key, mime: row.content_type,
      width: row.width, height: row.height, duration_ms: row.duration_ms ?? null, bytes: Number(row.bytes),
    });
  }
  return out;
}

module.exports = { store, sniff, hasAlpha, audioDurationMs, SLOT_NAME, SLOT_DIR };
