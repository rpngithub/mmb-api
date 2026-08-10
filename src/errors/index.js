const AppError = require('./AppError');

class ValidationError extends AppError {
  constructor(msg, details) { super(msg, 400, 'VALIDATION_ERROR', details); }
}

class AuthError extends AppError {
  constructor(msg) { super(msg, 401, 'UNAUTHORIZED'); }
}

class ForbiddenError extends AppError {
  constructor(msg) { super(msg, 403, 'FORBIDDEN'); }
}

class NotFoundError extends AppError {
  constructor(msg) { super(msg, 404, 'NOT_FOUND'); }
}

class ConflictError extends AppError {
  constructor(msg) { super(msg, 409, 'CONFLICT'); }
}

class QuotaError extends AppError {
  constructor(msg) { super(msg, 402, 'QUOTA_EXCEEDED'); }
}

class RateLimitError extends AppError {
  constructor(msg) { super(msg, 429, 'RATE_LIMIT_EXCEEDED'); }
}

// Both are 401s from /auth/refresh, so a client that already sends the user to
// login on a 401 needs no change. The distinct codes let one that cares do better:
//
//   TOKEN_REUSE_DETECTED — an already-rotated refresh token was replayed. Every
//     session for the account has been signed out. Not retryable: log in again,
//     and it is worth telling the user this was a security measure.
//   REFRESH_IN_PROGRESS  — a refresh raced with another one, or an old token was
//     retried moments after rotating. Nothing was revoked. Retry with the newest
//     refresh token; do NOT sign the user out.
class TokenReuseError extends AppError {
  constructor(msg) { super(msg, 401, 'TOKEN_REUSE_DETECTED'); }
}

class RefreshInProgressError extends AppError {
  constructor(msg) { super(msg, 401, 'REFRESH_IN_PROGRESS'); }
}

module.exports = {
  AppError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  QuotaError,
  RateLimitError,
  TokenReuseError,
  RefreshInProgressError,
};
