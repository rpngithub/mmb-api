const aiJobs = require('../services/aiJob.service');
const providers = require('../ai/providers');
const credentialStore = require('../ai/credentialStore');
const { AuthError, NotFoundError } = require('../errors');

const listOperations = async (req, res) => {
  const items = await aiJobs.listOperations(req.user.userId);
  res.json({ success: true, data: items, meta: { total: items.length } });
};

const estimate = async (req, res) => {
  const data = await aiJobs.estimate(req.params.key, req.body);
  res.json({ success: true, data });
};

// 202 for a new job; 200 when the Idempotency-Key replays one that exists.
const submit = async (req, res) => {
  const { job, replay } = await aiJobs.submit(
    req.user.userId, req.params.key, req.body, req.get('Idempotency-Key'),
  );
  res.status(replay ? 200 : 202).json({ success: true, data: await aiJobs.serialize(job) });
};

const getJob = async (req, res) => {
  res.json({ success: true, data: await aiJobs.getForUser(req.params.uid, req.user.userId) });
};

const listJobs = async (req, res) => {
  const { items, total } = await aiJobs.listForUser(req.user.userId, req.query);
  res.json({ success: true, data: items, meta: { total } });
};

// POST /webhooks/ai/:provider. Unauthenticated; the signature is the auth.
//
// Answers 200 for anything correctly signed — including a task we do not know or
// a job already finished — so the provider does not retry forever. The update is
// applied in the background: copying a result into S3 can outlast a provider's
// webhook timeout.
const webhook = async (req, res) => {
  const { AiProvider, AiJob } = require('../models');
  const adapter  = providers.get(req.params.provider);
  const provider = adapter && await AiProvider.findOne({ where: { key: req.params.provider } });
  if (!adapter || !provider) throw new NotFoundError('Unknown provider');

  const secrets = await credentialStore.webhookSecrets(provider);
  if (!adapter.verifyWebhook({ rawBody: req.rawBody, headers: req.headers, secrets, provider })) {
    throw new AuthError('Invalid webhook signature');
  }

  const update = adapter.parseWebhook({ body: req.body, headers: req.headers });
  if (!update || !update.taskId) return res.json({ success: true, data: { ignored: 'unrecognised' } });

  const job = await AiJob.findOne({ where: { provider_id: provider.id, provider_task_id: String(update.taskId) } });
  if (!job) return res.json({ success: true, data: { ignored: 'unknown_task' } });

  aiJobs.track(aiJobs.applyProviderUpdate(job, update, adapter));
  return res.json({ success: true, data: { received: true } });
};

module.exports = { listOperations, estimate, submit, getJob, listJobs, webhook };
