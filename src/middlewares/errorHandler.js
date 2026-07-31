function errorHandler(err, req, res, next) {
  if (err.name === 'SequelizeValidationError') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: err.errors.map((e) => ({ field: e.path, message: e.message })),
      },
    });
  }

  if (err.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({
      success: false,
      error: {
        code: 'CONFLICT',
        message: 'Duplicate entry',
        details: err.errors.map((e) => ({ field: e.path, message: e.message })),
      },
    });
  }

  // A delete blocked by an onDelete:RESTRICT foreign key (e.g. deleting a role that
  // is still assigned to an admin user). Surface as a clean 409 instead of a 500.
  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return res.status(409).json({
      success: false,
      error: {
        code: 'CONFLICT',
        message: 'This record is still referenced by other records and cannot be deleted',
        details: [],
      },
    });
  }

  if (err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      error: { code: err.errorCode, message: err.message, details: err.details || [] },
    });
  }

  console.error('[UNHANDLED ERROR]', err);
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
  });
}

module.exports = errorHandler;
