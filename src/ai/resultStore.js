const s3 = require('../utils/s3Helper');
const http = require('./http');
const { INTERNAL, ProviderError } = require('./errors');

// Copies a finished job's files into OUR storage, at once. Provider result URLs
// expire in minutes (Magnific: 30, background removal: 5), so the app is never
// handed one — it gets our S3 key, and the file appears in the user's media
// library (slot `ai_result`, prefix users/<uid>/ai/).
//
// Storage IS charged (ledger source `ai_result`) but NOT enforced: the user has
// already paid credits for this result, and throwing it away because their
// storage is full would be the worst possible outcome. They see the usage and can
// free space afterwards.
//
// Idempotent per file: the key is derived from the job, so a finalize that runs
// twice finds its own row and reuses it.

const SLOT_NAME = 'ai_result';
const SLOT_DIR  = 'ai';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

// What the bytes actually are — never the provider's declared type.
function sniff(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
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

/**
 * @param job      ai_jobs row (needs id, uid, user_id, operation_key)
 * @param files    [{ buffer } | { url }] from the adapter
 * @param adapter  for its allowedHosts
 * @returns [{ media_uid, s3_key, mime, width, height, bytes }]
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
    if (!mime) throw new ProviderError(INTERNAL.RESULT_FETCH_FAILED, 'after_start', { detail: 'result is not a supported image' });
    if (mime === 'image/svg+xml') assertSafeSvg(bytes);

    const key = `users/${user.uid}/${SLOT_DIR}/${job.uid}/${i + 1}.${EXT[mime]}`;
    let row = await UserUpload.findOne({ where: { s3_key: key } });
    if (!row) {
      await s3.uploadFile(key, bytes, mime);
      const dims = mime === 'image/png' ? pngSize(bytes) : {};
      row = await UserUpload.create({
        user_id: user.id, s3_key: key, slot: SLOT_NAME, bytes: bytes.length, content_type: mime,
        width: dims.width || null, height: dims.height || null,
        original_filename: `${job.operation_key}-${i + 1}.${EXT[mime]}`,
      });
      await quota.consume(user.id, 'storage', bytes.length, { source: 'ai_result', ref_type: 'user_upload', ref_id: row.id });
    }
    out.push({
      media_uid: row.uid, s3_key: row.s3_key, mime: row.content_type,
      width: row.width, height: row.height, bytes: Number(row.bytes),
    });
  }
  return out;
}

module.exports = { store, sniff, SLOT_NAME, SLOT_DIR };
