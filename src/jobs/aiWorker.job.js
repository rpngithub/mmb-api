const { withAdvisoryLock, NOT_ACQUIRED } = require('../utils/advisoryLock');
const worker   = require('../ai/worker');
const aiConfig = require('../config/ai');

// Runs the AI dispatcher on exactly one instance.
//
// Every TRY_EVERY_MS each instance tries the `mmb_ai_worker` advisory lock with
// timeout 0. The one that gets it keeps it for a LEASE, ticking every
// AI_WORKER_TICK_MS, then lets go so leadership can move. Holding a lease rather
// than re-taking the lock per tick matters: the rate-limit buckets live in the
// leader's memory, and leadership flipping between instances every tick would let
// each spend the provider's whole per-minute budget.
//
// Each tick first checks the lock is still held on its own connection — after a
// DB failover it is not, and this instance stands down.
//
// AI_WORKER_ENABLED=false is the kill switch: requests are still charged and
// queued, nothing is sent, and they go out when it is switched back on.

const TRY_EVERY_MS = 10 * 1000;
const LEASE_MS     = 10 * 60 * 1000;
const LOCK_NAME    = 'mmb_ai_worker';

let timer = null;
let running = false;
let stopping = false;
const status = { leader: false, lastTickAt: null, lastError: null };

// The pause between ticks, cut short by wake(). A text job (captions) takes a
// second or two at the provider, so waiting out a whole AI_WORKER_TICK_MS before
// even sending it would be most of the user's wait. Submit calls wake(); on the
// leader that starts the next tick at once. On any other instance it is a no-op
// and the job goes out on the leader's next tick, as before.
let wakeUp = null;
function nap(ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); wakeUp = null; resolve(); };
    const t = setTimeout(done, ms);
    wakeUp = done;
  });
}
const wake = () => { if (wakeUp) wakeUp(); };

async function lead({ stillHeld }) {
  status.leader = true;
  const until = Date.now() + LEASE_MS;
  try {
    while (!stopping && Date.now() < until && aiConfig.workerEnabled()) {
      if (!(await stillHeld())) {
        console.warn('[AI] worker lost its lock — standing down');
        break;
      }
      try {
        await worker.tick();
        status.lastTickAt = new Date();
        status.lastError = null;
      } catch (err) {
        status.lastError = err.message;
        console.error(`[AI] worker tick failed: ${err.message}`);
      }
      await nap(aiConfig.tickMs());
    }
  } finally {
    // Sends run in the background (ai/worker.js). Let them finish while we still
    // hold the lock, so the next leader never overlaps them with fresh buckets.
    try { await worker.drain(); } catch (err) { console.error(`[AI] drain failed: ${err.message}`); }
    status.leader = false;
  }
}

async function tryLead() {
  if (running || stopping || !aiConfig.workerEnabled()) return;
  running = true;
  try {
    const out = await withAdvisoryLock(LOCK_NAME, 0, lead);
    if (out === NOT_ACQUIRED) status.leader = false;
  } catch (err) {
    console.error(`[AI] worker could not take the lock: ${err.message}`);
  } finally {
    running = false;
  }
}

const job = {
  start() {
    if (timer) return;
    if (!aiConfig.workerEnabled()) {
      console.warn('[AI] AI_WORKER_ENABLED=false — AI jobs are accepted and charged but NOT sent');
    }
    stopping = false;
    timer = setInterval(tryLead, TRY_EVERY_MS);
    tryLead();
  },
  stop() {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
    wake();
  },
};

module.exports = { job, status, wake, LOCK_NAME };
