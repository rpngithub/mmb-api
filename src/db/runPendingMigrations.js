// Applies pending migrations during app startup, coordinated by a MySQL
// advisory lock so that when several instances boot at once only ONE runs the
// migrations; the others wait for the lock, then find nothing pending. Lets the
// app keep its own schema up to date on deploy without a shell (e.g. Hostinger,
// where `npm run migrate` can't be run over SSH). Gate it with the
// RUN_MIGRATIONS_ON_BOOT env var — see server.js.
const path = require('path');
const { run } = require('./_runner');
const sequelize = require('../config/db');

const LOCK_NAME            = 'mmb_migrate';
const LOCK_TIMEOUT_SECONDS = 120;

// GET_LOCK is tied to the connection (session) that acquired it, and the lock
// is only released by that same connection. With Sequelize's pool, a plain
// sequelize.query() for GET_LOCK and a later one for RELEASE_LOCK could land on
// different pooled connections, leaking the lock. So we pin one dedicated
// connection for the lock's whole lifetime; the migrations themselves can use
// the pool freely — the lock just needs to be HELD, not run every statement.
async function runPendingMigrations() {
  const conn = await sequelize.connectionManager.getConnection();
  const query = (sql, params) =>
    new Promise((resolve, reject) => {
      conn.query(sql, params, (err, results) => (err ? reject(err) : resolve(results)));
    });

  try {
    const rows   = await query('SELECT GET_LOCK(?, ?) AS locked', [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
    const locked = rows && rows[0] && rows[0].locked;
    if (locked !== 1) {
      throw new Error(
        `Could not acquire migration lock '${LOCK_NAME}' within ${LOCK_TIMEOUT_SECONDS}s ` +
        '(another instance may be mid-migration, or a previous run left it held).'
      );
    }
    try {
      await run({
        dir:       path.resolve(__dirname, 'migrations'),
        table:     'SequelizeMeta',
        direction: 'up',
      });
    } finally {
      await query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
  } finally {
    sequelize.connectionManager.releaseConnection(conn);
  }
}

module.exports = runPendingMigrations;
