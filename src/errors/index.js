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

module.exports = {
  AppError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  QuotaError,
  RateLimitError,
};
