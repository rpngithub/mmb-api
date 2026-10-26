// What an upload may be, and the app_settings keys that bound it.
//
// The TYPE LISTS and the NUMBERS are admin-tunable (app_settings, group
// `uploads`); what lives here is the part that must not be: which file extensions
// a MIME type may carry. A type an admin adds to a list must appear in this map,
// or the settings rule refuses it — the server cannot check a file whose
// extension and signature it knows nothing about.
//
// Sizes are stored in MB (like the plan storage feature) and always reported to
// clients in BYTES, so nothing ever compares a File.size against megabytes.

const EXTENSIONS = {
  'image/jpeg':      ['jpg', 'jpeg'],
  'image/png':       ['png'],
  'image/webp':      ['webp'],
  'image/gif':       ['gif'],
  // Admin only. SVG can carry script and user files are served back to browsers,
  // so the settings rule refuses it in the user list whatever an admin types.
  'image/svg+xml':   ['svg'],
  'video/mp4':       ['mp4', 'm4v'],
  'video/webm':      ['webm'],
  'video/quicktime': ['mov'],
};

const KINDS  = ['image', 'video'];
const SCOPES = ['user', 'admin'];

const kindOfType = (type) => {
  const kind = String(type || '').split('/')[0];
  return KINDS.includes(kind) && EXTENSIONS[type] ? kind : null;
};

// The type a file extension implies, for a request that sent no content_type (an
// older client). First match wins; no two types share an extension.
const typeForExtension = (ext) =>
  Object.keys(EXTENSIONS).find((t) => EXTENSIONS[t].includes(String(ext || '').toLowerCase())) || null;

const key = {
  maxMb:         (scope, kind) => `upload_${scope}_${kind}_max_mb`,
  batchMaxFiles: (scope, kind) => `upload_${scope}_${kind}_batch_max_files`,
  batchTotalMb:  (scope)       => `upload_${scope}_batch_max_total_mb`,
  types:         (scope, kind) => `upload_${scope}_${kind}_types`,
};

const USER_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_TYPES      = ['video/mp4', 'video/webm', 'video/quicktime'];

// Used when a row is missing or holds a value its rule refuses — and seeded by
// migration 054 as the starting values.
const DEFAULTS = {
  user: {
    image: { max_mb: 10,  batch_max_files: 20, types: USER_IMAGE_TYPES },
    video: { max_mb: 100, batch_max_files: 5,  types: VIDEO_TYPES },
    batch_max_total_mb: 300,
  },
  admin: {
    image: { max_mb: 25,  batch_max_files: 50, types: [...USER_IMAGE_TYPES, 'image/svg+xml'] },
    video: { max_mb: 500, batch_max_files: 10, types: VIDEO_TYPES },
    batch_max_total_mb: 2048,
  },
};

// A single presigned PUT tops out at 5 GB on S3, so no per-file limit above that
// can actually be honoured.
const MAX_MB_CEILING = 5120;

module.exports = {
  EXTENSIONS, KINDS, SCOPES, DEFAULTS, MAX_MB_CEILING, key, kindOfType, typeForExtension,
};
