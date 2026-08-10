const {
  generateOtp, deliverSms, smsConfig, buildMessage, realSendEnabled, toLocalNumber, DLT_TEMPLATE,
} = require('../utils/otpHelper');

/**
 * Diagnostics for the Ping4SMS wiring, for use from development where the normal
 * OTP path never reaches the vendor (see realSendEnabled in utils/otpHelper.js) and
 * so proves nothing about the credentials a staging or production deploy will use.
 *
 * The text sent is the real DLT template with a throwaway code — not a caller-supplied
 * message. Anything that isn't the registered template is dropped by the operator
 * *after* the API has already reported success, so a custom message would make this
 * endpoint answer "delivered" for a text that never arrives: the exact failure it
 * exists to catch.
 *
 * Nothing is written to otp_codes, so the code returned here cannot be used to log in.
 */
async function testSms({ phone, dry_run = false }) {
  const { url, sender, templateid, route, missing, key } = smsConfig();
  const otp = generateOtp();

  const report = {
    environment: {
      node_env:          process.env.NODE_ENV,
      sms_enabled:       process.env.SMS_ENABLED ?? null,
      // False in development, which is why this endpoint bypasses it: it calls the
      // vendor directly rather than going through sendOtp.
      real_send_enabled: realSendEnabled(),
    },
    config: {
      api_url:     url || null,
      sender_id:   sender || null,
      template_id: templateid || null,
      route,
      // Presence only — never echo the key.
      api_key:     key ? 'set' : 'missing',
      missing,
    },
    request: {
      // Throws a 400 for a non-Indian number before anything is sent.
      number:   toLocalNumber(phone),
      otp,
      message:  buildMessage(otp),
      template: DLT_TEMPLATE,
    },
  };

  if (dry_run) {
    return { ...report, dry_run: true, vendor: null };
  }

  const result = await deliverSms(phone, report.request.message);

  return {
    ...report,
    dry_run: false,
    vendor: {
      delivered:       result.delivered,
      http_status:     result.status,
      // The vendor's own words: a numeric message id on success, otherwise the reason.
      body:            result.body,
      message_id:      result.delivered ? result.body : null,
      transport_error: result.transportError,
    },
  };
}

module.exports = { testSms };
