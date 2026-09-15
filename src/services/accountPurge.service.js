const { Op } = require('sequelize');
const sequelize = require('../config/db');
const models    = require('../models');
const s3        = require('../utils/s3Helper');
const razorpay  = require('../utils/razorpayHelper');
const config    = require('./config.service');

const {
  User, Business, Project, ProjectExport, UserFrame, UserUpload, UserQuotaUsage, UserQuotaGrant,
  QuotaUsageEvent, UserBillingDetail, UserPreference, UserLanguage, UserNotification,
  UserNotificationSetting, Feedback, Font, UserSession, TokenBlacklist, OtpCode, UserSubscription,
  Payment, BusinessCategory, ActivityLog,
} = models;

// Editable from the admin panel (/admin/app-settings). The migration that added
// the key seeds 24; this is only the fallback if the row is ever deleted.
const GRACE_SETTING_KEY   = 'account_deletion_grace_hours';
const DEFAULT_GRACE_HOURS = 24;

// How many accounts one job run will take on. Each purge is a handful of DELETEs
// plus an S3 listing, so this is generous; it exists so a backlog (the job was
// down for a day) drains over a few runs instead of one long-held lock.
const MAX_PER_RUN = 50;

const graceHours = () => config.getSetting(GRACE_SETTING_KEY, DEFAULT_GRACE_HOURS);

// What the deactivate response tells the user: "your data will be permanently
// deleted on …". Recomputed from the setting each time rather than stored, so an
// admin shortening the grace period applies to accounts already in the window.
async function deletionScheduledAt(deactivatedAt) {
  const hours = await graceHours();
  return new Date(new Date(deactivatedAt).getTime() + hours * 60 * 60 * 1000);
}

// The accounts whose grace period has run out. `deactivated_at` is set by
// SELF-deactivation only — admin deactivation is moderation and never lands here.
async function findDue(limit = MAX_PER_RUN) {
  const hours  = await graceHours();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  return User.findAll({
    where: { deactivated_at: { [Op.lte]: cutoff }, purged_at: null, is_active: 0 },
    order: [['deactivated_at', 'ASC']],
    limit,
  });
}

/**
 * Permanently removes everything a user owns, then leaves a tombstone.
 *
 * Tombstone, not DELETE FROM users: `payments` cascade with the user row, and
 * those are GST invoices that have to be retained. Keeping the row (stripped of
 * every personal field) keeps payments, subscription history and the activity log
 * resolvable, and freeing `phone` lets the same person sign up again from scratch.
 *
 * Order matters:
 *   1. Razorpay first. A recurring subscription (UPI Autopay) keeps charging
 *      whether or not we have a row for it, so if cancellation fails the purge
 *      does not proceed — the account is retried next run, data intact.
 *   2. S3 next. Every user object lives under users/<uid>/ (userUpload.service),
 *      so one prefix delete covers logo, products, profile photo, fonts, project
 *      files. If THIS fails the run also stops, so a DB wipe never orphans objects
 *      that nothing can find any more.
 *   3. The database, in one transaction. Cascades do not fire (the user row
 *      stays), so every owned table is hit explicitly. Ownership across tables is
 *      by user_id; anything scoped to a business goes with the business.
 *
 * Idempotent: running it twice on the same account is harmless, so a crash
 * between S3 and the transaction is recovered by the next run.
 */
async function purgeUser(user) {
  // 1. Stop the money.
  const recurring = await UserSubscription.findAll({
    where: { user_id: user.id, razorpay_subscription_id: { [Op.ne]: null }, status: { [Op.in]: ['active', 'pending'] } },
  });
  for (const sub of recurring) {
    try {
      await razorpay.cancelSubscription(sub.razorpay_subscription_id);
    } catch (err) {
      // Already cancelled/completed at their end is fine — the point is that no
      // further charge can happen. Anything else (network, auth) is not.
      const desc = String(err?.error?.description || err?.message || '');
      if (!/not cancellable|already cancelled|completed|expired/i.test(desc)) {
        throw new Error(`Razorpay cancel failed for ${sub.razorpay_subscription_id}: ${desc}`);
      }
    }
  }

  // 2. Objects.
  await s3.deleteByPrefix(`users/${user.uid}/`);

  // 3. Rows.
  await sequelize.transaction(async (transaction) => {
    const byUser = { where: { user_id: user.id }, transaction };

    // Businesses cascade their products, images, keywords, tags, variant grants.
    await Business.destroy(byUser);
    await ProjectExport.destroy(byUser);
    await Project.destroy(byUser);
    await UserFrame.destroy(byUser);
    await UserUpload.destroy(byUser);
    await UserQuotaUsage.destroy(byUser);
    await UserQuotaGrant.destroy(byUser);
    await QuotaUsageEvent.destroy(byUser);
    await UserPreference.destroy(byUser);
    await UserLanguage.destroy(byUser);
    await UserNotification.destroy(byUser);
    await UserNotificationSetting.destroy(byUser);
    await Feedback.destroy(byUser);
    await Font.destroy(byUser);                   // their own uploads; library fonts have user_id NULL

    // Billing details are the name/address/GSTIN an invoice is issued to. They go
    // unless an invoice was actually issued, in which case they stay with the
    // payments they belong to — a reissued invoice has to carry the same details.
    if (!(await Payment.count({ where: { user_id: user.id }, transaction }))) {
      await UserBillingDetail.destroy(byUser);
    }

    // Subscription rows stay as billing history but must not read as live.
    await UserSubscription.update(
      { status: 'cancelled', cancelled_at: new Date() },
      { where: { user_id: user.id, status: { [Op.in]: ['active', 'pending'] } }, transaction },
    );

    // Auth artefacts (no FK to users, so nothing else would clear them).
    await UserSession.destroy({ where: { actor_type: 'user', actor_id: user.id }, transaction });
    await TokenBlacklist.destroy({ where: { actor_type: 'user', actor_id: user.id }, transaction });
    if (user.phone) await OtpCode.destroy({ where: { phone: user.phone }, transaction });

    // A suggested industry outlives its suggester (SET NULL, per migration 014).
    await BusinessCategory.update({ suggested_by_user_id: null }, { where: { suggested_by_user_id: user.id }, transaction });

    // The tombstone. Every field a person could be identified by goes; the id, uid
    // and razorpay_customer_id stay, because payments hang off them.
    await User.update({
      name:                 'Deleted User',
      phone:                null,
      email:                null,
      password_hash:        null,
      profile_photo_s3_key: null,
      account_type:         null,
      onboarding_completed_at: null,
      is_active:            0,
      purged_at:            new Date(),
    }, { where: { id: user.id }, transaction });

    // Written directly rather than through activity.service, which is shaped
    // around a request. actor is the system (null), the entity is the user.
    await ActivityLog.create({
      actor_type: null, actor_id: null,
      entity_type: 'user', entity_id: user.id,
      action: 'account_purged',
      metadata: { user_uid: user.uid, deactivated_at: user.deactivated_at, recurring_cancelled: recurring.length },
    }, { transaction });
  });
}

// One job tick. Each account is its own unit of work: a failure on one (Razorpay
// down for that call, say) is logged and the rest still proceed, and the failed
// one is simply due again next run.
async function runOnce() {
  const due = await findDue();
  let purged = 0, failed = 0;
  for (const user of due) {
    try {
      await purgeUser(user);
      purged++;
    } catch (err) {
      failed++;
      console.error(`[AccountPurge] user ${user.id} (${user.uid}) failed, will retry: ${err.message}`);
    }
  }
  return { due: due.length, purged, failed };
}

module.exports = { purgeUser, findDue, runOnce, deletionScheduledAt, graceHours, GRACE_SETTING_KEY, DEFAULT_GRACE_HOURS };
