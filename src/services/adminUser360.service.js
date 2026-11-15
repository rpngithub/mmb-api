// Read-only "User 360" views for the admin User Detail page: one user's plan,
// subscriptions, payments, businesses, designs and headline counts.
//
// v1 is READ-ONLY on purpose — nothing here changes a subscription or payment.
// Every list is paged (limit max 100) and resolves the user by uid first, so an
// unknown uid is a 404 rather than an empty page that looks like a real answer.
const { Op } = require('sequelize');
const {
  sequelize, User, UserBillingDetail, UserSession, UserSubscription, Plan, PlanBillingOption, Coupon,
  Payment, ProjectExport, Project, Template, Business, BusinessCategory, BusinessVariant, Variant, Frame, AiJob,
} = require('../models');
const paymentRepo = require('../repositories/payment.repository');
const billing     = require('./billing.service');
const { NotFoundError, ValidationError } = require('../errors');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 100;

const SUB_STATUSES      = ['pending', 'active', 'overridden', 'cancelled', 'expired'];
const PAYMENT_STATUSES  = ['pending', 'success', 'failed', 'refunded'];
const PURCHASE_TYPES    = ['subscription', 'frame', 'quota_pack', 'variant'];
const PLAN_STATES       = ['free', 'paid', 'trial', 'access_pass', 'expired'];
const ACCOUNT_TYPES     = ['business', 'personal'];

function paging(q = {}) {
  return {
    limit:  Math.min(parseInt(q.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT),
    offset: Math.max(parseInt(q.offset, 10) || 0, 0),
  };
}

function assertOneOf(field, value, allowed) {
  if (!allowed.includes(value)) {
    throw new ValidationError('Validation failed', [{ field, message: `${field} must be one of: ${allowed.join(', ')}` }]);
  }
}

async function resolveUser(uid) {
  const user = await User.findOne({ where: { uid }, attributes: ['id', 'uid'] });
  if (!user) throw new NotFoundError('User not found');
  return user;
}

// ---- Plan state (users list filter + current_plan) ----

// A user can hold two active rows (the open access-pass bug: a pass bought on top
// of a paid plan). Everywhere here the NEWEST active row is "the" current plan,
// so the filter and the `current_plan` column always agree.
const NEWEST_ACTIVE = `(SELECT MAX(s.id) FROM user_subscriptions s WHERE s.user_id = \`User\`.\`id\` AND s.status = 'active')`;
const SUB_TYPE_FOR  = { paid: 'regular', trial: 'trial', access_pass: 'access_pass' };

// SQL condition on the users query for one plan_state. Values are fixed strings
// from the map above — never request input — so the literal is safe.
function planStateCondition(state) {
  assertOneOf('plan_state', state, PLAN_STATES);
  if (SUB_TYPE_FOR[state]) {
    return sequelize.literal(
      `EXISTS (SELECT 1 FROM user_subscriptions cur WHERE cur.id = ${NEWEST_ACTIVE} AND cur.sub_type = '${SUB_TYPE_FOR[state]}')`,
    );
  }
  const hasActive = `EXISTS (SELECT 1 FROM user_subscriptions a WHERE a.user_id = \`User\`.\`id\` AND a.status = 'active')`;
  // "Has ever subscribed" = a row that got past 'pending' (an abandoned checkout is not a subscription).
  const hasEver   = `EXISTS (SELECT 1 FROM user_subscriptions e WHERE e.user_id = \`User\`.\`id\` AND e.status <> 'pending')`;
  return state === 'expired'
    ? sequelize.literal(`(NOT ${hasActive} AND ${hasEver})`)
    : sequelize.literal(`(NOT ${hasEver})`);   // free: never subscribed
}

// Extra WHERE conditions for GET /admin/users.
function userListConditions({ account_type, plan_state, is_active } = {}) {
  const and = [];
  if (account_type) {
    assertOneOf('account_type', account_type, ACCOUNT_TYPES);
    and.push({ account_type });
  }
  if (is_active !== undefined && is_active !== '') {
    assertOneOf('is_active', String(is_active), ['0', '1']);
    and.push({ is_active: Number(is_active) });
  }
  if (plan_state) and.push(planStateCondition(plan_state));
  return and;
}

const currentPlanOf = (sub) => (sub ? {
  name:       sub.Plan?.name ?? null,
  plan_type:  sub.Plan?.plan_type ?? null,
  sub_type:   sub.sub_type,
  status:     sub.status,
  ends_at:    sub.ends_at,
  auto_renew: !!sub.auto_renew,
} : null);

// One query for the whole page: every active row for these users, newest first,
// keeping the first seen per user. `null` = no active subscription (free tier).
async function currentPlansFor(userIds) {
  const map = new Map();
  if (!userIds.length) return map;
  const subs = await UserSubscription.findAll({
    where: { user_id: userIds, status: 'active' },
    attributes: ['id', 'user_id', 'sub_type', 'status', 'ends_at', 'auto_renew'],
    include: [{ model: Plan, attributes: ['name', 'plan_type'] }],
    order: [['id', 'DESC']],
  });
  for (const s of subs) if (!map.has(s.user_id)) map.set(s.user_id, s);
  return map;
}

async function attachCurrentPlans(users) {
  const plans = await currentPlansFor(users.map((u) => u.id));
  return users.map((u) => ({ ...u.toJSON(), current_plan: currentPlanOf(plans.get(u.id)) }));
}

// ---- User detail extras ----

async function countsFor(userId) {
  const [projects, downloads, shares, aiJobs, businesses, activeSessions] = await Promise.all([
    Project.count({ where: { user_id: userId } }),
    ProjectExport.count({ where: { user_id: userId, export_type: 'download', status: 'success' } }),
    ProjectExport.count({ where: { user_id: userId, export_type: 'share', status: 'success' } }),
    AiJob.count({ where: { user_id: userId } }),
    Business.count({ where: { user_id: userId } }),
    UserSession.count({ where: { actor_type: 'user', actor_id: userId, is_revoked: 0, expires_at: { [Op.gt]: new Date() } } }),
  ]);
  return { projects, downloads, shares, ai_jobs: aiJobs, businesses, active_sessions: activeSessions };
}

// `user` is the detail row (password_hash already excluded). `includeBilling` is
// decided by the caller from the admin's permissions: billing details carry
// GSTIN and address, so they are shown only with billing.read.
async function detailExtras(user, { includeBilling }) {
  const [counts, activeCount, billingDetails] = await Promise.all([
    countsFor(user.id),
    UserSubscription.count({ where: { user_id: user.id, status: 'active' } }),
    includeBilling ? UserBillingDetail.findOne({ where: { user_id: user.id }, attributes: { exclude: ['id', 'user_id'] } }) : null,
  ]);
  const extras = { has_active_subscription: activeCount > 0, counts };
  if (includeBilling) extras.billing_details = billingDetails;
  return extras;
}

// ---- Subscriptions ----

async function listSubscriptions(userUid, q = {}) {
  const user  = await resolveUser(userUid);
  const where = { user_id: user.id };
  if (q.status) {
    assertOneOf('status', q.status, SUB_STATUSES);
    where.status = q.status;
  }
  return UserSubscription.findAndCountAll({
    where,
    attributes: ['uid', 'status', 'sub_type', 'starts_at', 'ends_at', 'cancelled_at', 'auto_renew',
      'amount_paid', 'razorpay_subscription_id', 'created_at', 'updated_at'],
    include: [
      { model: Plan,              attributes: ['uid', 'name', 'plan_type'] },
      { model: PlanBillingOption, attributes: ['billing_cycle', 'price', 'currency'] },
      { model: Coupon,            attributes: ['code'] },
    ],
    order: [['id', 'DESC']],
    ...paging(q),
  });
}

// ---- Payments ----

function paymentRow(payment) {
  const p = payment.toJSON();
  return {
    uid:                   p.uid,
    description:           billing.describe(payment),
    purchase_type:         p.purchase_type || (p.subscription_id ? 'subscription' : 'frame'),
    order_type:            p.order_type,
    amount:                Number(p.amount),
    amount_before_tax:     Number(p.amount_before_tax),
    gst_rate:              Number(p.gst_rate),
    gst_amount:            Number(p.gst_amount),
    currency:              p.currency,
    // Stored state; display_status is what the user's Billing screen shows
    // (a stale pending order reads 'abandoned', a reported failure 'failed').
    status:                p.status,
    display_status:        billing.displayStatus(p),
    payment_method:        p.payment_method,
    payment_method_detail: p.payment_method_detail,
    invoice_number:        p.invoice_number,
    failure_reason:        p.failure_reason,
    razorpay_order_id:     p.razorpay_order_id,
    razorpay_payment_id:   p.razorpay_payment_id,
    paid_at:               p.paid_at,
    created_at:            p.created_at,
    has_invoice:           p.status === 'success',
  };
}

async function listPayments(userUid, q = {}) {
  const user  = await resolveUser(userUid);
  const where = { user_id: user.id };
  if (q.status) {
    assertOneOf('status', q.status, PAYMENT_STATUSES);
    where.status = q.status;
  }
  if (q.purchase_type) {
    assertOneOf('purchase_type', q.purchase_type, PURCHASE_TYPES);
    // NULL purchase_type predates the column and was always a frame.
    where.purchase_type = q.purchase_type === 'frame' ? { [Op.or]: ['frame', null] } : q.purchase_type;
  }
  const { rows, count } = await Payment.findAndCountAll({
    where,
    attributes: { exclude: ['razorpay_signature'] },
    include: paymentRepo.DESCRIBE,
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    distinct: true,
    ...paging(q),
  });
  return { rows: rows.map(paymentRow), count };
}

// ---- Businesses ----

async function listBusinesses(userUid) {
  const user = await resolveUser(userUid);
  const businesses = await Business.findAll({
    where: { user_id: user.id },
    attributes: ['id', 'uid', 'name', 'description', 'logo_s3_key', 'address', 'city', 'state', 'phone', 'whatsapp',
      'email', 'website', 'rating_avg', 'rating_count', 'is_active', 'watermark_enabled', 'created_at'],
    include: [
      { model: BusinessCategory, attributes: ['uid', 'name'] },
      { model: Frame, as: 'activeFrame', attributes: ['uid', 'name'] },
    ],
    order: [['id', 'DESC']],
  });

  // Variants in use: business_variants has no association, so two flat queries
  // for every business on the page.
  const ids   = businesses.map((b) => b.id);
  const links = ids.length ? await BusinessVariant.findAll({ where: { business_id: ids }, order: [['id', 'ASC']] }) : [];
  const variantIds = [...new Set(links.map((l) => l.variant_id))];
  const variants = variantIds.length
    ? await Variant.findAll({ where: { id: variantIds }, attributes: ['id', 'uid', 'name'] })
    : [];
  const byId = new Map(variants.map((v) => [v.id, { uid: v.uid, name: v.name }]));

  return businesses.map((b) => {
    const { id, ...row } = b.toJSON();
    row.variants = links.filter((l) => l.business_id === id).map((l) => byId.get(l.variant_id)).filter(Boolean);
    return row;
  });
}

// ---- Projects ----

async function listProjects(userUid, q = {}) {
  const user = await resolveUser(userUid);
  const { rows, count } = await Project.findAndCountAll({
    where: { user_id: user.id },
    attributes: [
      'uid', 'name', 'project_type', 'status', 'thumbnail_s3_key', 'created_at', 'updated_at',
      [sequelize.literal('(SELECT COUNT(*) FROM project_exports pe WHERE pe.project_id = `Project`.`id`)'), 'export_count'],
    ],
    include: [
      { model: Template, attributes: ['uid', 'name'] },
      { model: Business, attributes: ['uid', 'name'] },
    ],
    order: [['updated_at', 'DESC'], ['id', 'DESC']],
    ...paging(q),
  });
  // COUNT(*) comes back from the driver as a string.
  return { rows: rows.map((p) => ({ ...p.toJSON(), export_count: Number(p.get('export_count')) || 0 })), count };
}

module.exports = {
  resolveUser, userListConditions, attachCurrentPlans, detailExtras,
  listSubscriptions, listPayments, listBusinesses, listProjects,
  PLAN_STATES,
};
