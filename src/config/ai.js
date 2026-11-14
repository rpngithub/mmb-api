// Deployment knobs for AI jobs. Read from process.env on each call (like
// config/quota.js) so a test can flip one. Admin-tunable numbers (concurrency
// cap, timeouts, margins) are app_settings instead — see settings() below.

const int = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
};

// The kill switch. false = the worker stands down on every instance; requests
// are still accepted, charged and queued, and go out once it is switched back on.
const workerEnabled = () => process.env.AI_WORKER_ENABLED !== 'false';
const tickMs        = () => Math.max(int('AI_WORKER_TICK_MS', 2000), 250);

// Public base URL providers call back on, e.g. https://api.staging.example.com.
// Unset (dev tunnels are private) = no callback is sent and jobs are polled.
const publicWebhookBase = () => (process.env.AI_PUBLIC_WEBHOOK_BASE_URL || '').replace(/\/+$/, '') || null;

// Accounts held to no ai_credits limit (an unlimited plan, a plan with no
// ai_credits row, no active free plan, or ai_credits in QUOTA_RELAXED_FEATURES)
// would get AI that costs us real money without any ceiling. Refused unless this
// is set — for dev and tests only.
const allowUnmetered = () => process.env.AI_ALLOW_UNMETERED === 'true';

const API_PREFIX = () => `/api/${process.env.API_VERSION || 'v1'}`;

// app_settings, with their fallbacks. One query.
const SETTING_DEFAULTS = {
  ai_max_concurrent_jobs_per_user: 3,
  ai_job_timeout_minutes:          15,
  ai_unknown_resolve_minutes:      30,
  ai_moderation_strikes_per_hour:  5,
  ai_spillover_wait_seconds:       60,
};

async function settings() {
  const config = require('../services/config.service');
  return config.getSettings(SETTING_DEFAULTS);
}

module.exports = { workerEnabled, tickMs, publicWebhookBase, allowUnmetered, settings, API_PREFIX, SETTING_DEFAULTS };
