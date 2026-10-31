const { mailConfig, transporter, realSendEnabled } = require('../utils/mailer');

/**
 * Diagnostics for the SMTP wiring, for use from development, where sendMail only logs
 * and so proves nothing about the credentials staging or production will use.
 *
 * Two stages, reported separately because they fail for different reasons:
 *   verify — connect, TLS, AUTH (wrong host/port/SECURE pairing, bad password)
 *   send   — the server accepting this sender and recipient (MAIL_FROM not allowed
 *            for this account, relay refused)
 *
 * Failures come back in the 200 body rather than as an error status: the SMTP
 * server's own response text is the useful part, and it would be lost in a 502.
 */
async function testEmail({ to, dry_run = false }) {
  const cfg = mailConfig();

  const report = {
    environment: {
      node_env:          process.env.NODE_ENV,
      mail_enabled:      process.env.MAIL_ENABLED ?? null,
      // False in development, which is why this endpoint bypasses it.
      real_send_enabled: realSendEnabled(),
    },
    config: {
      host:     cfg.host || null,
      port:     cfg.port,
      secure:   cfg.secure,
      user:     cfg.user || null,
      // Presence only — never echo the password.
      password: process.env.SMTP_PASS ? 'set' : 'missing',
      from:     cfg.from || null,
      tls_insecure: cfg.tlsInsecure,
      missing:  cfg.missing,
    },
  };

  if (cfg.missing.length) return { ...report, verify: null, send: null };

  const transport = transporter(cfg);
  const failure = (err) => ({ ok: false, error: err.message, code: err.code || null, response: err.response || null });

  let verify;
  try {
    await transport.verify();
    verify = { ok: true };
  } catch (err) {
    return { ...report, verify: failure(err), send: null };
  }

  if (dry_run) return { ...report, dry_run: true, verify, send: null };

  try {
    const info = await transport.sendMail({
      from:    cfg.from,
      to,
      subject: 'Make My Brand — SMTP test',
      text:    `This is a test email from the Make My Brand API (${process.env.NODE_ENV}). If you can read it, SMTP works.`,
    });
    return {
      ...report,
      dry_run: false,
      verify,
      send: { ok: true, message_id: info.messageId, accepted: info.accepted, rejected: info.rejected, response: info.response },
    };
  } catch (err) {
    return { ...report, dry_run: false, verify, send: failure(err) };
  }
}

module.exports = { testEmail };
