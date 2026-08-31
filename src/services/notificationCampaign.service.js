const { Op } = require('sequelize');
const { NotificationCampaign, NotificationTemplate, UserNotification } = require('../models');
const segment  = require('./notificationSegment');
const notify   = require('./notification.service');
const render   = require('../utils/renderTemplate');
const dedupe   = require('../utils/dedupeKey');
const cfg      = require('../config/notifications');
const { ValidationError, ForbiddenError, NotFoundError } = require('../errors');

// Admin broadcasts: compose, preview, schedule, send, cancel.
//
// The fan-out is the interesting part. A campaign over 100k users cannot insert
// 100k rows inside one cron tick, so it works in keyset batches and stores a
// cursor. Two decisions make that safe:
//
//   1. INSERT FIRST, ADVANCE THE CURSOR SECOND, in separate commits. A crash
//      between them re-runs the batch, whose rows all collide on
//      dedupe_key 'campaign:<id>' and are ignored. The reverse order would skip
//      those users permanently. Ordering gives at-least-once; the unique index
//      upgrades it to exactly-once.
//   2. The dedupe key is campaign-scoped, NOT chunk-scoped. Chunk boundaries shift
//      when the underlying segment changes between ticks, and a chunk-scoped key
//      would let a shifted boundary double-send.
//
// A transaction around the two would buy nothing and would hold row locks across a
// 500-row insert.

// Terminal states never move again.
const TERMINAL = ['sent', 'cancelled', 'failed'];

// How long one tick is allowed to spend draining before yielding, so a large
// campaign cannot monopolise the job and starve the date-anchored scans that share
// the same tick.
const TICK_BUDGET_MS = 25 * 1000;

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

// A campaign either carries its own copy or inherits a template's. Resolved once,
// here, so preview and send cannot disagree about what will be sent.
async function resolveContent(campaign) {
  let base = {
    title: campaign.title, body: campaign.body,
    cta_label: campaign.cta_label, cta_action: campaign.cta_action,
    cta_params: campaign.cta_params, image_s3_key: campaign.image_s3_key,
    category_id: campaign.category_id,
    is_promotional: 1, is_dismissible: 1, display_priority: 'normal',
    expires_after_days: null, variable_defaults: null,
  };

  if (campaign.template_id) {
    const tpl = await NotificationTemplate.findByPk(campaign.template_id);
    if (!tpl) throw new NotFoundError('The template this campaign is based on no longer exists');
    base = {
      // Campaign copy overrides the template's, field by field, so an admin can
      // reuse a template and reword just the headline.
      title:      campaign.title      || tpl.title,
      body:       campaign.body       || tpl.body,
      cta_label:  campaign.cta_label  || tpl.cta_label,
      cta_action: campaign.cta_action || tpl.cta_action,
      cta_params: campaign.cta_params || tpl.cta_params,
      image_s3_key: campaign.image_s3_key || tpl.image_s3_key,
      category_id:  campaign.category_id  || tpl.category_id,
      is_promotional:     tpl.is_promotional,
      is_dismissible:     tpl.is_dismissible,
      display_priority:   tpl.display_priority,
      expires_after_days: tpl.expires_after_days,
      variable_defaults:  tpl.variable_defaults,
      template_id:        tpl.id,
    };
  }

  if (!base.title || !base.body) {
    throw new ValidationError('A campaign needs a title and a body — either its own, or from a template');
  }

  // Campaign copy is sent as-is to everyone, so it cannot carry per-user
  // placeholders. Catching it here means the admin finds out while composing
  // rather than by shipping a literal "{{name}}" to the whole segment.
  const unresolved = [...render.tokensIn(base.title), ...render.tokensIn(base.body)]
    .filter((t) => !(base.variable_defaults || {})[t]);
  if (unresolved.length) {
    throw new ValidationError(
      `Campaign copy has placeholder(s) with no value: ${[...new Set(unresolved)].join(', ')}. ` +
      'Campaign copy is identical for every recipient, so it cannot use per-user variables.',
    );
  }

  return base;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * What this campaign would do if sent now: how many people, a few real examples,
 * and the fully rendered message.
 *
 * The count comes from the same builder the fan-out pages through, so the number
 * shown is the number that ships.
 */
async function preview(uid) {
  const campaign = await _find(uid);
  const content  = await resolveContent(campaign);

  const [total, sample] = await Promise.all([
    segment.countAudience(campaign.audience),
    segment.sampleUsers(campaign.audience, 5),
  ]);

  return {
    audience_count: total,
    sample,
    preview: {
      title:      content.title,
      body:       content.body,
      cta_label:  content.cta_label,
      cta_action: content.cta_action,
    },
    // Said plainly, because "sent 8,412 of 10,000" otherwise reads as a failure.
    note: campaign.bypass_fatigue
      ? 'Fatigue caps are bypassed for this campaign. Recipients who muted this category, or who opted out of marketing, are still excluded.'
      : 'The final number will be lower: recipients who muted this category, opted out of marketing, or have hit their daily/weekly notification cap are skipped.',
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function _find(uid) {
  const campaign = await NotificationCampaign.findOne({ where: { uid } });
  if (!campaign) throw new NotFoundError('Campaign not found');
  return campaign;
}

// adminCrud `beforeWrite`: keep ordinary edits off a campaign that has started.
// Rewording something half-sent would leave two different messages in the wild
// under one campaign id.
async function assertCampaignWritable(payload, row) {
  if (row && !['draft', 'scheduled'].includes(row.status)) {
    throw new ForbiddenError(
      `A campaign that is '${row.status}' can no longer be edited. Duplicate it into a new draft instead.`,
    );
  }
  if (payload.audience) segment.buildWhere(payload.audience);   // fail fast on a bad filter
}

async function schedule(uid, scheduledAt, adminId) {
  const campaign = await _find(uid);
  if (!['draft', 'scheduled'].includes(campaign.status)) {
    throw new ForbiddenError(`Cannot schedule a campaign that is '${campaign.status}'`);
  }
  await resolveContent(campaign);   // refuse to schedule something that cannot render

  // Snapshot the count so the panel shows a stable figure rather than one that
  // drifts under the admin between approving and sending.
  const audienceCount = await segment.countAudience(campaign.audience);

  await campaign.update({
    status: 'scheduled', scheduled_at: scheduledAt,
    audience_count: audienceCount, created_by: campaign.created_by || adminId,
  });
  return campaign;
}

async function sendNow(uid) {
  const campaign = await _find(uid);
  if (!['draft', 'scheduled'].includes(campaign.status)) {
    throw new ForbiddenError(`Cannot send a campaign that is '${campaign.status}'`);
  }
  await resolveContent(campaign);

  const audienceCount = await segment.countAudience(campaign.audience);
  await campaign.update({
    status: 'sending', scheduled_at: campaign.scheduled_at || new Date(),
    started_at: new Date(), audience_count: audienceCount,
  });
  return campaign;
}

async function cancel(uid) {
  const campaign = await _find(uid);
  if (TERMINAL.includes(campaign.status)) {
    throw new ForbiddenError(`Campaign is already '${campaign.status}'`);
  }
  // Rows already inserted are left alone: they have been seen. Recalling them is a
  // different feature, and every row carries campaign_id if we ever build it.
  await campaign.update({ status: 'cancelled', completed_at: new Date() });
  return campaign;
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

/** Moves due scheduled campaigns into `sending`. */
async function promoteDue(now = new Date()) {
  const [count] = await NotificationCampaign.update(
    { status: 'sending', started_at: now },
    { where: { status: 'scheduled', scheduled_at: { [Op.lte]: now } } },
  );
  return count;
}

/**
 * Drains one campaign for at most `budgetMs`, then yields. Returns what it did so
 * the job can log it.
 */
async function drainOne(campaignId, budgetMs = TICK_BUDGET_MS) {
  const started = Date.now();
  let inserted = 0;
  let skipped  = 0;
  let batches  = 0;

  const campaign = await NotificationCampaign.findByPk(campaignId);
  if (!campaign || campaign.status !== 'sending') return { inserted, skipped, batches, done: false };

  const content  = await resolveContent(campaign);
  const limit    = cfg.batchSize();
  const dedupeKey = dedupe.forCampaign(campaign.id);

  // A campaign either rides on a template (inheriting its gates) or is its own
  // one-off. For the one-off case a synthetic template object carries the same
  // shape, so dispatchBulk applies identical rules either way.
  const tpl = content.template_id
    ? await NotificationTemplate.findByPk(content.template_id)
    : {
      id: null, code: `campaign_${campaign.id}`, is_active: 1,
      title: content.title, body: content.body,
      cta_label: content.cta_label, cta_action: content.cta_action,
      cta_params: content.cta_params, image_s3_key: content.image_s3_key,
      category_id: content.category_id, variable_defaults: null,
      trigger_type: 'manual', audience_account_type: 'all', audience_plan: 'all',
      is_promotional: content.is_promotional, is_dismissible: content.is_dismissible,
      display_priority: content.display_priority,
      expires_after_days: content.expires_after_days,
      cooldown_hours: null, max_occurrences: null,
    };

  while (Date.now() - started < budgetMs) {
    // Re-read the status each batch so a cancellation lands within one batch
    // rather than at the end of the campaign.
    const fresh = await NotificationCampaign.findByPk(campaign.id);
    if (!fresh || fresh.status !== 'sending') return { inserted, skipped, batches, done: false };

    const users = await segment.selectUsers(fresh.audience, {
      afterId: fresh.cursor_user_id, limit,
    });

    if (!users.length) {
      await fresh.update({ status: 'sent', completed_at: new Date() });
      return { inserted, skipped, batches, done: true };
    }

    const result = await notify.dispatchBulk({
      code: tpl.code,
      template: tpl,
      userIds: users.map((u) => u.id),
      variables: {},
      dedupeKey,
      overrides: {
        campaign_id: campaign.id,
        category_id: content.category_id,
        title: content.title, body: content.body,
        cta_label: content.cta_label, cta_action: content.cta_action,
        cta_params: content.cta_params, image_s3_key: content.image_s3_key,
        bypass_fatigue: Boolean(fresh.bypass_fatigue),
      },
    });

    inserted += result.inserted;
    skipped  += result.skipped;
    batches  += 1;

    // INSERT FIRST, THEN the cursor — see the header. Never the other way round.
    await fresh.update({
      cursor_user_id: users[users.length - 1].id,
      sent_count:    fresh.sent_count + result.inserted,
      skipped_count: fresh.skipped_count + result.skipped,
    });
  }

  return { inserted, skipped, batches, done: false };
}

/** One dispatcher tick: promote what is due, then drain what is sending. */
async function runDispatchTick(now = new Date()) {
  const promoted = await promoteDue(now);

  const sending = await NotificationCampaign.findAll({
    where: { status: 'sending' }, order: [['scheduled_at', 'ASC']], limit: 5,
  });

  let inserted = 0;
  let skipped  = 0;
  for (const c of sending) {
    try {
      const r = await drainOne(c.id);
      inserted += r.inserted;
      skipped  += r.skipped;
    } catch (err) {
      // One broken campaign must not stop the others, and it must not retry
      // forever — record why and move on.
      console.error(`[NotificationDispatch] campaign ${c.uid} failed: ${err.message}`);
      await c.update({ status: 'failed', error_message: err.message.slice(0, 500), completed_at: new Date() });
    }
  }

  return { promoted, campaigns: sending.length, inserted, skipped };
}

/**
 * Releases notifications that were held back by quiet hours and are now due.
 *
 * They were inserted at decision time with a future deliver_at (so a retry could
 * not queue a second copy); this is what makes them visible.
 */
async function releaseScheduled(now = new Date()) {
  const [count] = await UserNotification.update(
    { status: 'delivered' },
    { where: { status: 'scheduled', deliver_at: { [Op.lte]: now } } },
  );
  return count;
}

module.exports = {
  resolveContent,
  preview,
  assertCampaignWritable,
  schedule,
  sendNow,
  cancel,
  promoteDue,
  drainOne,
  runDispatchTick,
  releaseScheduled,
  TERMINAL,
};
