const nodemailer   = require('nodemailer');
const { AppError } = require('../errors');

// Transactional email over SMTP: verification links, phone-change links and the
// "your account changed" notices. Nothing promotional goes through here.
//
// Same send rules as SMS (utils/otpHelper): development and test never send — the
// message is logged and the callers echo the link in their response instead —
// while staging and production send for real. MAIL_ENABLED=true forces a real send
// from dev (to check the SMTP wiring); MAIL_ENABLED=false silences sends anywhere.
const DEV_ENVS = ['development', 'test'];

function realSendEnabled() {
  if (process.env.MAIL_ENABLED === 'true')  return true;
  if (process.env.MAIL_ENABLED === 'false') return false;
  return !DEV_ENVS.includes(process.env.NODE_ENV);
}

// Read on each call rather than at require time, so a test or a restart-free env
// change is picked up. Never returns the password, only whether one is set.
function mailConfig() {
  const env = process.env;
  const cfg = {
    host:   env.SMTP_HOST,
    port:   Number.parseInt(env.SMTP_PORT || '587', 10),
    // 465 is implicit TLS; 587 starts plain and upgrades with STARTTLS.
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : env.SMTP_PORT === '465',
    user:   env.SMTP_USER,
    from:   env.MAIL_FROM,
  };
  // Skips certificate verification on the SMTP connection — for a development laptop
  // whose antivirus or proxy re-signs TLS. Honoured ONLY in development, so a copied
  // env file cannot weaken staging or production; there it is ignored with a warning.
  cfg.tlsInsecure = env.SMTP_TLS_INSECURE === 'true' && env.NODE_ENV === 'development';
  if (env.SMTP_TLS_INSECURE === 'true' && !cfg.tlsInsecure) {
    console.warn(`[MAIL] SMTP_TLS_INSECURE is ignored outside development (NODE_ENV=${env.NODE_ENV})`);
  }
  cfg.missing = Object.entries({
    SMTP_HOST: env.SMTP_HOST, SMTP_USER: env.SMTP_USER, SMTP_PASS: env.SMTP_PASS, MAIL_FROM: env.MAIL_FROM,
  }).filter(([, v]) => !v).map(([k]) => k);
  return cfg;
}

// One transporter per process — it pools nothing by default, but building it reads
// and validates the config, which there is no reason to repeat per message. Keyed
// on the config so a changed env produces a fresh one.
let cached = null;
function transporter(cfg) {
  const key = `${cfg.host}|${cfg.port}|${cfg.secure}|${cfg.user}|${cfg.tlsInsecure}`;
  if (cached && cached.key === key) return cached.transport;
  if (cfg.tlsInsecure) {
    console.warn('[MAIL] SMTP certificate verification is OFF (SMTP_TLS_INSECURE=true, development only)');
  }
  const transport = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: process.env.SMTP_PASS },
    ...(cfg.tlsInsecure ? { tls: { rejectUnauthorized: false } } : {}),
  });
  cached = { key, transport };
  return transport;
}

const maskEmail = (email) => {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 2)}***@${domain}`;
};

/**
 * Sends one message. Throws a 502 the caller can let through when the server
 * refuses it — a link the user never receives must not be reported as sent.
 */
async function sendMail({ to, subject, text, html }) {
  if (!realSendEnabled()) {
    console.log(`[MAIL DEV] to ${to} — ${subject}\n${text}`);
    return { sent: false };
  }

  const cfg = mailConfig();
  if (cfg.missing.length) {
    throw new AppError(`Email is not configured: missing ${cfg.missing.join(', ')}`, 500, 'MAIL_NOT_CONFIGURED');
  }

  try {
    const info = await transporter(cfg).sendMail({ from: cfg.from, to, subject, text, html });
    console.log(`[MAIL] sent to ${maskEmail(to)} (${info.messageId})`);
    return { sent: true };
  } catch (err) {
    console.error(`[MAIL] failed for ${maskEmail(to)}: ${err.message}`);
    throw new AppError('Could not send the email. Please try again.', 502, 'MAIL_SEND_FAILED');
  }
}

// Fire-and-forget, for notices that must never fail the request that caused them
// (the change has already happened by the time "your number was changed" goes out).
function sendMailQuietly(message) {
  return sendMail(message).catch((err) => {
    console.error(`[MAIL] notice not sent: ${err.message}`);
    return { sent: false };
  });
}

/**
 * Where the links in our emails point — the web app, which also hands the link to
 * the mobile app when App Links / Universal Links are set up for its domain. Refuses
 * to build a link from a missing base outside development, rather than mailing the
 * user something that goes nowhere.
 */
function appLink(path, params = {}) {
  const base = process.env.APP_WEB_URL || (DEV_ENVS.includes(process.env.NODE_ENV) ? 'http://localhost:3000' : '');
  if (!base) throw new AppError('APP_WEB_URL is not configured', 500, 'MAIL_NOT_CONFIGURED');
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

// Callers include the link in the response only where nothing is mailed, so local
// development and the tests can follow it — the same deal as the echoed OTP.
const echoLinks = () => DEV_ENVS.includes(process.env.NODE_ENV);

module.exports = {
  sendMail, sendMailQuietly, appLink, maskEmail, echoLinks, realSendEnabled, mailConfig,
  // For the dev SMTP test endpoint (services/devMail.service.js) — not part of the
  // normal send path.
  transporter,
};
