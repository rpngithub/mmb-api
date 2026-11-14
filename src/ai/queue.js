const { Op } = require('sequelize');

// The AI job queue — ai_jobs rows — behind a small interface (enqueue happens in
// aiJob.service.submit, inside the charge transaction; claim/transition here), so
// a real queue (BullMQ) can replace the storage later without touching the
// worker or the adapters.
//
// JOB STATE MACHINE. Every transition is a conditional UPDATE on the expected
// source state, so two actors racing (a late webhook and the timeout sweep, two
// dispatchers during a DB failover) can never both win:
//
//   queued     -> sending     worker claims it (affectedRows = 1 wins; THIS is
//                             the double-send guard, the advisory lock is only
//                             an optimisation)
//   sending    -> processing  async submit accepted; provider_task_id stored
//   sending    -> done        sync submit (BG removal); result copied to S3
//   sending    -> queued      failed BEFORE the request reached the provider
//                             (refused, DNS, 503, 429, our balance there):
//                             backed off via next_attempt_at
//   sending    -> failed      moderation / invalid input / attempts exhausted
//   sending    -> unknown     timeout or reset AFTER the request was written,
//                             or the sweep found the sender died mid-send.
//                             NEVER resent blindly: it may have started and be
//                             billed
//   processing -> done        webhook or status check: finished, files copied
//   processing -> failed      provider failed or moderated it; or timed out
//   unknown    -> processing  sweep: it has a task id, so it can be checked
//   unknown    -> failed      sweep or admin, after ai_unknown_resolve_minutes
//
// done and failed are terminal. A failed job always has refunded_at set — the
// refund commits in the same transaction as the move to `failed`.

const STATUS = {
  QUEUED: 'queued', SENDING: 'sending', PROCESSING: 'processing',
  UNKNOWN: 'unknown', DONE: 'done', FAILED: 'failed',
};
const IN_FLIGHT = [STATUS.QUEUED, STATUS.SENDING, STATUS.PROCESSING, STATUS.UNKNOWN];
const TERMINAL  = [STATUS.DONE, STATUS.FAILED];

const models = () => require('../models');

// Queued jobs due now, oldest first. Not a claim — the dispatcher decides per job
// whether a route has budget, then claims.
function due(now, limit) {
  const { AiJob } = models();
  return AiJob.findAll({
    where: {
      status: STATUS.QUEUED,
      [Op.or]: [{ next_attempt_at: null }, { next_attempt_at: { [Op.lte]: now } }],
    },
    order: [['id', 'ASC']],
    limit,
  });
}

// queued -> sending. Returns the claimed row, or null if someone else got it.
async function claim(job, { now, instance }) {
  const { AiJob, sequelize } = models();
  const [n] = await AiJob.update(
    {
      status: STATUS.SENDING, claimed_by: instance, claimed_at: now,
      attempts_count: sequelize.literal('attempts_count + 1'),
    },
    { where: { id: job.id, status: STATUS.QUEUED } },
  );
  if (!n) return null;
  return AiJob.findByPk(job.id);
}

// Generic guarded transition. `from` is one state or a list. Returns true when
// this caller made the change.
async function transition(jobId, from, patch, { transaction, where = {} } = {}) {
  const { AiJob } = models();
  const [n] = await AiJob.update(patch, {
    where: { id: jobId, status: Array.isArray(from) ? { [Op.in]: from } : from, ...where },
    ...(transaction ? { transaction } : {}),
  });
  return n === 1;
}

const requeue = (job, { now, delayMs }) => transition(job.id, STATUS.SENDING, {
  status: STATUS.QUEUED, next_attempt_at: new Date(now.getTime() + delayMs), claimed_by: null,
});

const markUnknown = (job, { now }) => transition(job.id, STATUS.SENDING, {
  status: STATUS.UNKNOWN, sent_at: job.sent_at || now,
});

// Queued jobs that could not go out this tick wait until `until` before due()
// returns them again. Only while still queued — never overrides a claim.
async function defer(jobIds, until) {
  if (!jobIds.length) return 0;
  const { AiJob } = models();
  const [n] = await AiJob.update({ next_attempt_at: until }, { where: { id: jobIds, status: STATUS.QUEUED } });
  return n;
}

module.exports = { STATUS, IN_FLIGHT, TERMINAL, due, claim, transition, requeue, markUnknown, defer };
