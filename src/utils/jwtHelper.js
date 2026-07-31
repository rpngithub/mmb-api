const jwt  = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { JWT_SECRET, JWT_ACCESS_EXPIRY, JWT_REFRESH_EXPIRY } = require('../config/jwt');

const signAccessToken = (payload) =>
  jwt.sign({ ...payload, jti: uuidv4() }, JWT_SECRET, { expiresIn: JWT_ACCESS_EXPIRY });

const signRefreshToken = (payload) =>
  jwt.sign({ ...payload, jti: uuidv4() }, JWT_SECRET, { expiresIn: JWT_REFRESH_EXPIRY });

const verifyToken = (token) => jwt.verify(token, JWT_SECRET);

module.exports = { signAccessToken, signRefreshToken, verifyToken };
