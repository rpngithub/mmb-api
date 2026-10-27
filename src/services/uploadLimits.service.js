const config = require('./config.service');
const { ValidationError } = require('../errors');
const {
  DEFAULTS, KINDS, EXTENSIONS, key, typeForExtension,
} = require('../constants/uploadTypes');

// ---- Upload limits and file-type checks, shared by user and admin uploads ----
//
// The numbers and type lists are app_settings (group `uploads`), read fresh on
// every call so an admin edit applies to the next presign. Everything a client
// sees is in BYTES.
//
// Two rules hold on both sides:
//   - A file's TYPE decides its kind: video/* is a video, everything else (images,
//     and the unchecked kinds like fonts or Lottie) counts against the image
//     limits for the per-request file count.
//   - Size checks need the client's declared `size`. A request without one (an
//     older app build) skips them here and relies on the check at confirm.

const MB = 1024 * 1024;
const toMb = (bytes) => Math.round((bytes / MB) * 10) / 10;

const bad = (field, message) => new ValidationError('Validation failed', [{ field, message }]);

const ext = (filename) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : 'bin';
};

// { image: { max_bytes, batch_max_files, types }, video: {...}, batch_max_total_bytes }
async function load(scope) {
  const d = DEFAULTS[scope];
  const fallbacks = { [key.batchTotalMb(scope)]: d.batch_max_total_mb };
  for (const kind of KINDS) {
    fallbacks[key.maxMb(scope, kind)]         = d[kind].max_mb;
    fallbacks[key.batchMaxFiles(scope, kind)] = d[kind].batch_max_files;
    fallbacks[key.types(scope, kind)]         = d[kind].types;
  }
  const s = await config.getSettings(fallbacks);

  const limits = { batch_max_total_bytes: s[key.batchTotalMb(scope)] * MB };
  for (const kind of KINDS) {
    limits[kind] = {
      max_bytes:       s[key.maxMb(scope, kind)] * MB,
      batch_max_files: s[key.batchMaxFiles(scope, kind)],
      types:           s[key.types(scope, kind)],
    };
  }
  return limits;
}

// The MIME type a file will be stored as, checked against `allowed`. `declared`
// is the client's content_type; without one (older clients) the extension
// decides. Either way the extension must belong to the type, so a key's
// extension always tells confirm what the bytes should be.
function resolveType({ declared, filename, allowed, at }) {
  const e    = ext(filename);
  const type = declared || typeForExtension(e);
  if (!type || !allowed.includes(type)) {
    const field = declared ? 'content_type' : 'filename';
    const what  = declared
      ? allowed.join(', ')
      : allowed.flatMap((t) => EXTENSIONS[t] || []).map((x) => `.${x}`).join(', ');
    throw bad(at(field), `${field === 'content_type' ? 'content_type' : 'file'} must be one of: ${what}`);
  }
  if (!(EXTENSIONS[type] || []).includes(e)) {
    throw bad(at('filename'), `a ${type} file must end in ${EXTENSIONS[type].map((x) => `.${x}`).join(' or ')}`);
  }
  return type;
}

const kindLabel = (kind) => (kind === 'video' ? 'videos' : 'images');

// Per-file cap. `kind` without limits (fonts, Lottie, …) is not checked here.
function assertFileSize({ kind, size, limits, at }) {
  const max = limits[kind] && limits[kind].max_bytes;
  if (size == null || !max) return;
  if (size > max) throw bad(at('size'), `file is ${toMb(size)} MB; the limit for ${kindLabel(kind)} is ${toMb(max)} MB`);
}

// Whole-request rules: file count per kind and combined declared size. Returns
// the declared total (0 when nothing declared a size).
function assertBatch(items, limits) {
  const videos = items.filter((i) => i.kind === 'video').length;
  const others = items.length - videos;
  if (videos > limits.video.batch_max_files) {
    throw bad('files', `at most ${limits.video.batch_max_files} videos per request (got ${videos})`);
  }
  if (others > limits.image.batch_max_files) {
    throw bad('files', `at most ${limits.image.batch_max_files} files per request (got ${others})`);
  }
  const total = items.reduce((sum, i) => sum + (i.size || 0), 0);
  if (total > limits.batch_max_total_bytes) {
    throw bad('files', `selected files total ${toMb(total)} MB; the limit per request is ${toMb(limits.batch_max_total_bytes)} MB`);
  }
  return total;
}

// ---- File signatures ----
// The declared type is only the client's word; the first bytes of the object
// decide. Checked at confirm on a short ranged read. A type with no signature
// here (fonts, audio, Lottie) is not checked.
const ascii = (b, start, end) => b.subarray(start, end).toString('latin1');
const PNG  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
// MP4 and MOV are both ISO base media files: a box size, then a box type. ftyp
// comes first in practice; very old QuickTime files can open with these others.
const ISO_BOXES = ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'];

const SIGNATURES = {
  'image/jpeg':      (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png':       (b) => b.subarray(0, 8).equals(PNG),
  'image/gif':       (b) => ascii(b, 0, 4) === 'GIF8',
  'image/webp':      (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  // Text, so the best the first bytes can say is "this starts like an SVG".
  'image/svg+xml':   (b) => /^\s*(<\?xml|<svg|<!--|<!doctype svg)/i.test(b.toString('utf8').replace(/^﻿/, '')),
  'video/mp4':       (b) => ISO_BOXES.includes(ascii(b, 4, 8)),
  'video/quicktime': (b) => ISO_BOXES.includes(ascii(b, 4, 8)),
  'video/webm':      (b) => b.subarray(0, 4).equals(EBML),
};
const SNIFF_BYTES = 64;

const hasSignature = (type) => Boolean(SIGNATURES[type]);
const matchesSignature = (type, bytes) => !SIGNATURES[type] || SIGNATURES[type](bytes);

// The words a per-file confirm rejection reports. A ValidationError's message is
// only its title ("Validation failed"); the cause ("file exceeds the 25 MB
// limit") is in its details, and that is what a client can show the user.
const rejectionReason = (err) => (err.details && err.details[0] && err.details[0].message) || err.message;

// The type a stored key's extension implies — the extension was checked against
// the type at presign, so it is what the bytes have to be.
const typeOfKey = (k) => typeForExtension(ext(k));

module.exports = {
  MB, SNIFF_BYTES, toMb, ext, load, resolveType, assertFileSize, assertBatch,
  hasSignature, matchesSignature, typeOfKey, rejectionReason,
};
