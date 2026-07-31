const { ValidationError } = require('../errors');

const validate = (schema) => (req, res, next) => {
  const { error } = schema.validate(req.body, { abortEarly: false });
  if (!error) return next();

  const details = error.details.map((d) => ({
    field:   d.path.join('.'),
    message: d.message.replace(/['"]/g, ''),
  }));
  next(new ValidationError('Validation failed', details));
};

module.exports = validate;
