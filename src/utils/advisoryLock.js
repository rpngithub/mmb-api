// A MySQL advisory lock around a block of work, so that when several app
// instances try the same job only ONE runs it.
//
// Extracted from db/runPendingMigrations.js, which pioneered the pattern for boot
// migrations and now calls this. The notification scan jobs need the same thing:
// they run in-process on every instance (see server.js), and without coordination
// all N would run the same expensive scan and throw away 1-1/N of the work.
//
// GET_LOCK is tied to the CONNECTION (session) that acquired it, and only that
// same connection can release it. With Sequelize's pool, a plain sequelize.query()
// for GET_LOCK and a later one for RELEASE_LOCK could land on different pooled
// connections and leak the lock — so pin one dedicated connection for the lock's
// whole lifetime. The work inside can use the pool freely; the lock only needs to
// be HELD, not to run every statement.
//
// IMPORTANT — this is an optimisation, never a correctness guarantee. A connection
// that dies mid-run releases its lock, and a second instance can then start the
// same work. For the notification jobs that is harmless because every insert is
// idempotent under UNIQUE (user_id, dedupe_key); anything else using this helper
// must be able to say the same.
//
// Scope note: GET_LOCK is per MySQL SERVER. There is a single primary here, so it
// holds. It stops working silently the day a second writer appears — which is
// precisely when the idempotent-insert requirement above earns its keep.
const sequelize = require('../config/db');

// Distinguishable from any legitimate return value of the wrapped function,
// including undefined and null.
const NOT_ACQUIRED = Symbol('advisory_lock_not_acquired');

/**
 * Runs `fn` while holding the named lock.
 *
 * @param {string}   name           lock name, e.g. 'mmb_notif_behavioral'
 * @param {number}   timeoutSeconds 0 = fail immediately if someone else holds it.
 *                                  Use 0 for periodic jobs: a loser that waits
 *                                  would only acquire the lock after the winner
 *                                  finished, then redo identical work. Use a real
 *                                  timeout only when the work MUST happen on this
 *                                  process (boot migrations).
 * @param {Function} fn             the work
 * @returns {Promise<*>} fn's result, or the NOT_ACQUIRED symbol
 */
async function withAdvisoryLock(name, timeoutSeconds, fn) {
  const conn = await sequelize.connectionManager.getConnection();
  const query = (sql, params) =>
    new Promise((resolve, reject) => {
      conn.query(sql, params, (err, results) => (err ? reject(err) : resolve(results)));
    });

  try {
    const rows = await query('SELECT GET_LOCK(?, ?) AS locked', [name, timeoutSeconds]);
    // GET_LOCK returns 1 (acquired), 0 (timed out) or NULL (error, e.g. the name
    // is too long). Only 1 means we hold it.
    if (!rows || !rows[0] || rows[0].locked !== 1) return NOT_ACQUIRED;

    try {
      return await fn();
    } finally {
      await query('SELECT RELEASE_LOCK(?)', [name]);
    }
  } finally {
    sequelize.connectionManager.releaseConnection(conn);
  }
}

module.exports = { withAdvisoryLock, NOT_ACQUIRED };
