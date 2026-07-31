module.exports = {
  JWT_SECRET:          process.env.JWT_SECRET,
  JWT_ACCESS_EXPIRY:   process.env.JWT_ACCESS_EXPIRY  || '15m',
  JWT_REFRESH_EXPIRY:  process.env.JWT_REFRESH_EXPIRY || '30d',
};
