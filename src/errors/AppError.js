class AppError extends Error {
  constructor(message, statusCode, errorCode, details = []) {
    super(message);
    this.statusCode    = statusCode;
    this.errorCode     = errorCode;
    this.details       = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
