const bcrypt = require('bcryptjs');
const axios  = require('axios');
const { AppError, ValidationError } = require('../errors');

const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000));

const hashOtp = (otp) => bcrypt.hash(otp, 10);

const verifyOtp = (otp, hash) => bcrypt.compare(otp, hash);

// DLT (TRAI) approved template, copied character-for-character from the Ping4SMS
// dashboard. Only {#var#} may be substituted. Any other drift — punctuation, the
// missing space after "Customer,", the spacing before the -PNGOTP suffix — and the
// operator silently drops the message while the API still reports success. This
// string and PING4SMS_TEMPLATE_ID describe the same registered template: change one
// without the other and delivery stops with no visible error.
const DLT_TEMPLATE = 'Dear Customer,{#var#} is your verification code -PNGOTP';

const buildMessage = (otp) => DLT_TEMPLATE.replace('{#var#}', otp);

// Local-only envs. `staging` is deliberately absent: staging exercises the real
// vendor path, same as production.
const DEV_ENVS = ['development', 'test'];

/**
 * Route 2 is domestic-India and the vendor wants a bare 10-digit number, so strip
 * whatever the client wrapped it in (+91, 0-prefix, spaces, hyphens). The send-otp
 * validator accepts international numbers, so reject anything that isn't an Indian
 * mobile here rather than handing the vendor a number it will quietly drop.
 */
function toLocalNumber(phone) {
  const digits = String(phone).replace(/\D/g, '');
  const local  = digits.length > 10 ? digits.slice(-10) : digits;
  if (!/^[6-9]\d{9}$/.test(local)) {
    throw new ValidationError('Only Indian mobile numbers can receive an OTP', [
      { field: 'phone', message: 'Expected a 10-digit Indian mobile number, optionally prefixed with +91' },
    ]);
  }
  return local;
}

/**
 * Real sends stay off in development and test only, where sendOtpService echoes the
 * OTP in the response instead — no DLT credits burnt and no texts to whatever numbers
 * a local database happens to hold. Staging and production both send for real, so a
 * staging login costs credits and reaches the actual handset. SMS_ENABLED=false
 * silences sends anywhere (useful to park staging without redeploying a code change);
 * SMS_ENABLED=true forces a real send from dev.
 *
 * An unrecognised NODE_ENV sends for real, which is deliberate: that env also fails
 * the DEV_ENVS check in sendOtpService, so the OTP is not echoed either, and a real
 * send is the only way login still works.
 */
function realSendEnabled() {
  if (process.env.SMS_ENABLED === 'true')  return true;
  if (process.env.SMS_ENABLED === 'false') return false;
  return !DEV_ENVS.includes(process.env.NODE_ENV);
}

const maskPhone = (phone) => String(phone).replace(/\d(?=\d{4})/g, 'x');

/**
 * Vendor credentials plus the names of any that are missing, so a caller can report
 * what is unset without reading process.env itself. The key is never returned — only
 * whether one is present.
 */
function smsConfig() {
  const {
    PING4SMS_API_URL:     url,
    PING4SMS_API_KEY:     key,
    PING4SMS_SENDER_ID:   sender,
    PING4SMS_TEMPLATE_ID: templateid,
    PING4SMS_ROUTE:       route,
  } = process.env;

  const missing = Object.entries({
    PING4SMS_API_URL:     url,
    PING4SMS_API_KEY:     key,
    PING4SMS_SENDER_ID:   sender,
    PING4SMS_TEMPLATE_ID: templateid,
  }).filter(([, value]) => !value).map(([name]) => name);

  return { url, key, sender, templateid, route: route || '2', missing };
}

/**
 * One call to the vendor. Returns what happened rather than throwing on a rejection,
 * because the two callers want different things from a failure: sendOtp turns it into
 * a 502 the user never sees the detail of, while the dev test endpoint reports the raw
 * body — which is the only place the vendor explains itself (wrong key, unapproved
 * template, no credits). Still throws for a missing config or an unusable number,
 * which are caller errors, not vendor answers.
 */
async function deliverSms(phone, message) {
  const { url, key, sender, templateid, route, missing } = smsConfig();

  if (missing.length) {
    throw new AppError(`SMS is not configured: missing ${missing.join(', ')}`, 500, 'SMS_NOT_CONFIGURED');
  }

  // Outside the try: a bad phone number is a 400 for the caller, not a provider fault.
  const number = toLocalNumber(phone);

  let response;
  try {
    response = await axios.get(url, {
      params: { key, route, sender, number, sms: message, templateid },
      timeout: 10000,
      // The body is plain text. Left to itself axios runs JSON.parse over it, which
      // succeeds on an all-digit message id and hands back a Number instead of a
      // string — so keep the raw body.
      transformResponse: [(data) => data],
      // The vendor answers 200 for failures too, so the status must never decide on
      // its own; we inspect the body below. Taking every status here also keeps a
      // genuine 4xx/5xx loggable instead of throwing before we can read it.
      validateStatus: () => true,
    });
  } catch (err) {
    // Network-level failure (DNS, timeout, TLS) — there is no response to inspect.
    return { delivered: false, number, status: null, body: '', transportError: err.message };
  }

  const body = String(response.data ?? '').trim();

  return {
    // Success is a numeric message id; an error is a code or a plain-text message.
    delivered: response.status === 200 && /^\d{5,}$/.test(body),
    number,
    status:   response.status,
    body,
    transportError: null,
  };
}

const sendOtp = async (phone, otp) => {
  if (!realSendEnabled()) {
    console.log(`[OTP DEV] ${phone} → ${otp}`);
    return;
  }

  const result = await deliverSms(phone, buildMessage(otp));

  if (result.transportError) {
    throw new AppError(`Could not reach the SMS provider: ${result.transportError}`, 502, 'SMS_SEND_FAILED');
  }

  if (!result.delivered) {
    console.error(`[OTP SMS] failed for ${maskPhone(phone)} — HTTP ${result.status}, body: ${result.body.slice(0, 200)}`);
    throw new AppError('Could not send the OTP. Please try again.', 502, 'SMS_SEND_FAILED');
  }

  console.log(`[OTP SMS] sent to ${maskPhone(phone)} (message id ${result.body})`);
};

module.exports = {
  generateOtp, hashOtp, verifyOtp, sendOtp,
  // For the dev SMS test endpoint (services/devSms.service.js) — not part of the
  // normal auth path.
  deliverSms, smsConfig, buildMessage, realSendEnabled, DLT_TEMPLATE, toLocalNumber,
};
