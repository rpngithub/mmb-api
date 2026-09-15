/**
 * One phone number, one account.
 *
 * The Flutter app sends `+919876543210`, the web app sends `9876543210`, and
 * `users.phone` is a plain unique string — so the same handset signed up twice
 * and the profile completed on one client was "missing" on the other. Every
 * read and write of a login phone goes through here so the two spellings (and
 * `919876543210`, `09876543210`, spaces, hyphens) collapse to the same row.
 *
 * Canonical form is E.164: `+91XXXXXXXXXX`. That is what the mobile app already
 * sends and what the Swagger examples show; it also stays unambiguous if a
 * second country is ever allowed. The SMS vendor wants the bare 10 digits, and
 * otpHelper.toLocalNumber still derives that from this form.
 *
 * The product is India-only for now, so a bare 10-digit number is read as +91.
 * If that ever changes, the web app must start sending the country code and
 * this assumption goes.
 */

// Indian mobiles: 10 digits, first digit 6–9. Same rule as otpHelper.toLocalNumber.
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * Returns the E.164 form of an Indian mobile number, or null when the input is
 * not one. Callers that must reject (validators) test for null; callers that
 * only want the canonical key (auth service, rate limiter) fall back to the raw
 * value so a bad number still fails downstream the way it does today.
 */
function toE164(raw) {
  const str    = String(raw ?? '').trim();
  const digits = str.replace(/\D/g, '');

  let local;
  if (str.startsWith('+')) {
    // An explicit country code is taken at its word: `+9198765432` is a malformed
    // +91 number, not the (real) bare mobile 9198765432.
    local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : '';
  } else if (digits.length === 12 && digits.startsWith('91')) {
    local = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    local = digits.slice(1);
  } else {
    local = digits;
  }

  return INDIAN_MOBILE.test(local) ? `+91${local}` : null;
}

const normalizePhone = (raw) => toE164(raw) ?? raw;

module.exports = { toE164, normalizePhone };
