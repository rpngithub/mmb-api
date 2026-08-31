// Applies pending migrations during app startup, coordinated by a MySQL
// advisory lock so that when several instances boot at once only ONE runs the
// migrations; the others wait for the lock, then find nothing pending. Lets the
// app keep its own schema up to date on deploy without a shell (e.g. Hostinger,
// where `npm run migrate` can't be run over SSH). Gate it with the
// RUN_MIGRATIONS_ON_BOOT env var — see server.js.
//
// The connection-pinning mechanics of the lock now live in utils/advisoryLock.js,
// shared with the notification scan jobs. The two callers differ in one deliberate
// way: those jobs pass timeout 0 and stand down, because a loser that waited would
// only redo work the winner already did. Boot migrations must NOT stand down —
// serving traffic on a half-applied schema is worse than waiting — so this one
// waits, and treats a timeout as fatal.
const path = require('path');
const { run } = require('./_runner');
const { withAdvisoryLock, NOT_ACQUIRED } = require('../utils/advisoryLock');

const LOCK_NAME            = 'mmb_migrate';
const LOCK_TIMEOUT_SECONDS = 120;

async function runPendingMigrations() {
  const result = await withAdvisoryLock(LOCK_NAME, LOCK_TIMEOUT_SECONDS, () =>
    run({
      dir:       path.resolve(__dirname, 'migrations'),
      table:     'SequelizeMeta',
      direction: 'up',
    }));

  if (result === NOT_ACQUIRED) {
    throw new Error(
      `Could not acquire migration lock '${LOCK_NAME}' within ${LOCK_TIMEOUT_SECONDS}s ` +
      '(another instance may be mid-migration, or a previous run left it held).'
    );
  }

  return result;
}

module.exports = runPendingMigrations;
