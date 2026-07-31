// Shared test harness. Loading this FIRST (before app) sets the test env so
// config/db reads makemybrand_test and limiters skip Redis.
process.env.NODE_ENV = 'test';
require('dotenv').config({ path: '.env.test' });

const http = require('http');
const app  = require('../src/app');
const models = require('../src/models');
const { signAccessToken } = require('../src/utils/jwtHelper');

let server;
let port;

function start() {
  return new Promise((resolve) => {
    server = app.listen(0, () => { port = server.address().port; resolve(); });
  });
}

function stop() {
  return new Promise((resolve) => (server ? server.close(resolve) : resolve()));
}

function request(method, path, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) : null;
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': data.length } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const adminToken = (permissions = ['*'], userId = 1) => signAccessToken({ userId, actor_type: 'admin', permissions });
const userTokenFor = (userId, tier = 'free') => signAccessToken({ userId, actor_type: 'user', tier });

module.exports = { start, stop, request, adminToken, userTokenFor, models, app };
