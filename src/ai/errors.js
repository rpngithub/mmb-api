const AppError = require('../errors/AppError');

// Two vocabularies, kept apart on purpose.
//
// INTERNAL codes are what an adapter's normalizeError returns. They describe the
// provider (rate limited, down, out of our prepaid credits) and drive the
// worker's decisions — retry, requeue, fail. They are stored on ai_job_attempts
// and shown to admins only.
//
// PUBLIC codes are what the app sees on a job. "Our Magnific balance ran out" is
// a supplier problem and the user must never learn about it, or which supplier
// it is; to them it is simply AI_UNAVAILABLE, with their credits refunded.

const INTERNAL = {
  MODERATION_BLOCKED:      'MODERATION_BLOCKED',
  INVALID_INPUT:           'INVALID_INPUT',
  RATE_LIMITED:            'RATE_LIMITED',
  PROVIDER_DOWN:           'PROVIDER_DOWN',
  PROVIDER_OUT_OF_CREDITS: 'PROVIDER_OUT_OF_CREDITS',
  AUTH_FAILED:             'AUTH_FAILED',
  TIMEOUT:                 'TIMEOUT',
  TASK_FAILED:             'TASK_FAILED',
  RESULT_FETCH_FAILED:     'RESULT_FETCH_FAILED',
  NO_ROUTE:                'NO_ROUTE',
  ADMIN_RESOLVED:          'ADMIN_RESOLVED',   // an admin closed a stuck job and refunded it
  UNKNOWN:                 'UNKNOWN',
};

// Where in the send a failure happened — this, not the code alone, decides
// whether trying again is safe:
//   before_send  the request never reached the provider (DNS, refused, 503 at
//                the door, 429). No job started there, nothing billed: requeue.
//   after_send   the request went out and we never heard back. It may have
//                started and may be billed: mark `unknown`, NEVER resend blindly.
//   after_start  the provider accepted the task and then reported failure.
const PHASES = ['before_send', 'after_send', 'after_start'];

const PUBLIC = {
  MODERATION_BLOCKED: 'MODERATION_BLOCKED',
  INVALID_INPUT:      'INVALID_INPUT',
  AI_UNAVAILABLE:     'AI_UNAVAILABLE',
  AI_TIMEOUT:         'AI_TIMEOUT',
  AI_FAILED:          'AI_FAILED',
};

const PUBLIC_MESSAGES = {
  MODERATION_BLOCKED: 'This request was blocked by the content policy. Your credits have been refunded.',
  INVALID_INPUT:      'The AI service could not process this input. Your credits have been refunded.',
  AI_UNAVAILABLE:     'The AI service is temporarily unavailable. Your credits have been refunded.',
  AI_TIMEOUT:         'The AI service took too long to respond. Your credits have been refunded.',
  AI_FAILED:          'Something went wrong while generating this. Your credits have been refunded.',
};

function toPublic(internalCode) {
  switch (internalCode) {
    case INTERNAL.MODERATION_BLOCKED: return PUBLIC.MODERATION_BLOCKED;
    case INTERNAL.INVALID_INPUT:      return PUBLIC.INVALID_INPUT;
    case INTERNAL.RATE_LIMITED:
    case INTERNAL.PROVIDER_DOWN:
    case INTERNAL.PROVIDER_OUT_OF_CREDITS:
    case INTERNAL.AUTH_FAILED:
    case INTERNAL.NO_ROUTE:           return PUBLIC.AI_UNAVAILABLE;
    case INTERNAL.TIMEOUT:            return PUBLIC.AI_TIMEOUT;
    default:                          return PUBLIC.AI_FAILED;
  }
}

// A failure is never retried on another provider when it would fail anywhere
// (bad input) or when retrying is the wrong thing to do (moderation: shopping a
// blocked prompt around until somebody allows it is a Play Store and brand risk).
const isTerminal = (code) => code === INTERNAL.MODERATION_BLOCKED || code === INTERNAL.INVALID_INPUT;

// The error type every adapter throws or returns from normalizeError.
class ProviderError extends Error {
  constructor(code, phase, { httpStatus = null, detail = null, retryAfterMs = null } = {}) {
    super(`${code} (${phase})${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.phase = phase;
    this.httpStatus = httpStatus;
    this.detail = detail ? String(detail).slice(0, 500) : null;
    this.retryAfterMs = retryAfterMs;
  }
}

// HTTP errors raised at submit time, before anything is charged.
const httpError = {
  idempotencyRequired: () => new AppError('Idempotency-Key header is required', 400, 'AI_IDEMPOTENCY_KEY_REQUIRED'),
  idempotencyReused:   () => new AppError('This Idempotency-Key was already used for a different request', 409, 'AI_IDEMPOTENCY_KEY_REUSED'),
  operationNotFound:   () => new AppError('AI operation not found', 404, 'AI_OPERATION_NOT_FOUND'),
  inputNotFound:       (field) => new AppError('Referenced image not found', 404, 'AI_INPUT_NOT_FOUND', [{ field, message: 'not found in your uploads' }]),
  projectNotFound:     (field) => new AppError('Referenced project not found', 404, 'AI_INPUT_NOT_FOUND', [{ field, message: 'not found in your projects' }]),
  // `plans` = the active plans that include it, for an upgrade prompt.
  planRequired:        (plans) => new AppError('This AI feature is not included in your plan', 403, 'AI_PLAN_REQUIRED',
    plans.map((p) => ({ field: 'plan', message: `included in ${p.name}`, plan_uid: p.uid, plan_name: p.name }))),
  notInPlan:           () => new AppError('AI credits are not part of your plan', 403, 'AI_NOT_IN_PLAN'),
  tooManyJobs:         (n) => new AppError(`You already have ${n} AI requests in progress. Wait for one to finish.`, 429, 'AI_TOO_MANY_JOBS'),
  moderationCooldown:  () => new AppError('Too many requests were blocked by the content policy. Try again later.', 429, 'AI_MODERATION_COOLDOWN'),
  unavailable:         () => new AppError('The AI service is temporarily unavailable. Nothing was charged.', 503, 'AI_UNAVAILABLE'),
  jobNotFound:         () => new AppError('AI job not found', 404, 'NOT_FOUND'),
};

module.exports = {
  INTERNAL, PUBLIC, PHASES, PUBLIC_MESSAGES, toPublic, isTerminal, ProviderError, httpError,
};
