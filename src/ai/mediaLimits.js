// Limits on the images a user sends INTO an AI operation, shared by the adapters
// (which declare them per model) and the worker (which enforces them at send).
// Checked again at submit, before anything is charged (aiJob.service).

const MB = 1024 * 1024;

// Images sent inside the request body (Google). Google refuses requests past
// ~20 MB, and base64 adds a third — so 7 MB each, 14 MB together.
const INLINE_MAX_BYTES = 7 * MB;
const INLINE_MAX_TOTAL = 14 * MB;
const INLINE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];

const LABEL = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WEBP' };
const describe = (mimes) => mimes.map((m) => LABEL[m] || m).join(', ').replace(/, ([^,]*)$/, ' or $1');

module.exports = { MB, INLINE_MAX_BYTES, INLINE_MAX_TOTAL, INLINE_MIMES, describe };
