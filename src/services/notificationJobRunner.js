const os = require('os');
const { NotificationJobRun } = require('../models');
const { withAdvisoryLock, NOT_ACQUIRED } = require('../utils/advisoryLock');
const cfg = require('../config/notifications');

// One wrapper for every notification job, so they all get the same four things and
// none of them can quietly skip one:
//
//   1. The kill switch (NOTIFY_JOBS_ENABLED=false), so a misbehaving scan can be
//      stopped in production without a deploy.
//   2. A non-blocking advisory lock, so N app instances do not all run the same
//      expensive scan. Timeout 0 on purpose: a loser that WAITED would acquire the
//      lock once the winner finished and then redo identical work. This is an
//      optimisation only — correctness comes from UNIQUE (user_id, dedupe_key).
//   3. A notification_job_runs row. The jobs run in-process on every instance, so
//      each console.log lands in a different container; without this there is no
//      way to answer "did last night's dormancy scan run?", and a scan that has
//      been failing silently for a week is this feature's realistic failure mode.
//   4. Error containment. A throwing job must not take down the process.

const INSTANCE = `${os.hostname()}:${process.pid}`;

/**
 * @param {string}   jobKey   stable name, e.g. 'behavioral'
 * @param {Function} fn       async () => ({ scanned, inserted, skipped })
 */
async function runJob(jobKey, fn) {
  if (!cfg.jobsEnabled()) {
    console.log(`[Notify:${jobKey}] skipped — NOTIFY_JOBS_ENABLED=false`);
    return { skipped: 'disabled' };
  }

  const result = await withAdvisoryLock(`mmb_notify_${jobKey}`, 0, async () => {
    const run = await NotificationJobRun.create({ job_key: jobKey, instance: INSTANCE, status: 'running' });
    const started = Date.now();

    try {
      const out = await fn();
      await run.update({
        status: 'ok',
        scanned_count:  out?.scanned  || 0,
        inserted_count: out?.inserted || 0,
        skipped_count:  out?.skipped  || 0,
        finished_at: new Date(),
      });
      console.log(
        `[Notify:${jobKey}] ok in ${Date.now() - started}ms — ` +
        `scanned ${out?.scanned || 0}, sent ${out?.inserted || 0}, skipped ${out?.skipped || 0}`,
      );
      return out;
    } catch (err) {
      // Recorded rather than rethrown: the cron tick must not crash the API
      // process, and the run row is what makes the failure visible tomorrow.
      await run.update({
        status: 'failed',
        error_message: `${err.message}\n${err.stack || ''}`.slice(0, 4000),
        finished_at: new Date(),
      });
      console.error(`[Notify:${jobKey}] FAILED: ${err.message}`);
      return { error: err.message };
    }
  });

  if (result === NOT_ACQUIRED) {
    // The normal outcome on every instance but one. Recorded so that "nothing ran
    // anywhere" stays distinguishable from "one instance ran and the rest stood
    // down" — which is the question you actually ask during an incident.
    await NotificationJobRun.create({
      job_key: jobKey, instance: INSTANCE, status: 'skipped_locked', finished_at: new Date(),
    }).catch(() => {});
    return { skipped: 'locked' };
  }

  return result;
}

module.exports = { runJob, INSTANCE };
