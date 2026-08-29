const { v4: uuid }  = require('uuid');
const { Op }        = require('sequelize');
const frameRepo     = require('../repositories/frame.repository');
const framePublish  = require('./framePublish');
const userFrameRepo = require('../repositories/userFrame.repository');
const paymentRepo   = require('../repositories/payment.repository');
const { FrameCategory } = require('../models');
const { resolveRef, pick } = require('../utils/catalogRef');
// Imported as a namespace, not destructured: the gateway has no test double, so
// the suite swaps this function out at call time.
const razorpay      = require('../utils/razorpayHelper');
const { withGst }     = require('../utils/gst');
const { NotFoundError, ForbiddenError, ConflictError, ValidationError } = require('../errors');

const DEFAULT_LIMIT = 30;
const MAX_LIMIT     = 100;
const FRAME_TYPES   = ['static', 'animated'];

// Normalize a resolveRef() result into a filter id: undefined stays undefined
// (param absent → no filter); anything that did not resolve becomes 0 so the
// clause matches NOTHING. A bad category slug must return an empty shelf, never
// the whole store. Same rule the template catalogue follows.
const asFilterId = (resolved) => (resolved === undefined ? undefined : (resolved > 0 ? resolved : 0));

// The store card. `owned` drives the tick on the card, `is_locked` the price
// badge: a premium frame the viewer has not bought yet. Guests own nothing, so
// every premium frame reads as locked to them.
function toCard(row, ownedIds) {
  const f = row.toJSON();
  f.owned     = ownedIds.has(f.id);
  f.is_locked = Boolean(f.is_premium) && !f.owned;
  return f;
}

// ---- Store ----

// The frames store. Unlike the template catalogue this needs no mandatory anchor:
// the whole shelf is small and curated, and the design opens on "all frames of
// this tab" before any chip is tapped.
async function listStore(filters = {}, viewer = null) {
  const categoryId = asFilterId(await resolveRef(FrameCategory, pick(filters.category, filters.category_id)));

  const where = { status: 'active' };
  if (categoryId !== undefined) where.category_id = categoryId;
  if (FRAME_TYPES.includes(filters.frame_type)) where.frame_type = filters.frame_type;
  if (filters.is_premium !== undefined) where.is_premium = Number(filters.is_premium) ? 1 : 0;

  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const { rows, count } = await frameRepo.findForStore(where, { limit, offset });
  const ownedIds = await userFrameRepo.ownedFrameIds(viewer?.userId, rows.map((r) => r.id));

  return { total: count, items: rows.map((row) => toCard(row, ownedIds)) };
}

async function listCategories() {
  return FrameCategory.findAll({
    where:      { is_active: 1 },
    attributes: ['id', 'uid', 'name', 'slug', 'display_order'],
    order:      [['display_order', 'ASC'], ['id', 'ASC']],
  });
}

// Frame detail. The design payload is the thing being sold, so it is withheld
// until the viewer owns the frame — a free frame still has to be ADDED first,
// which keeps "what's on my shelf" an honest record rather than something the
// editor can bypass by fetching a uid directly.
//
// `is_locked` means the SAME thing here as on a store card — "this one costs
// money you have not paid" — so a client can drive one padlock badge from one
// field. It is deliberately NOT the answer to "can I render this?": a free frame
// is never locked, yet its content still arrives only once it has been added.
// `owned` is the field that governs content, and it is always present.
async function getFrame(uid, viewer = null) {
  const frame = await frameRepo.findActiveByUid(uid);
  if (!frame) throw new NotFoundError('Frame not found');

  const ownedIds = await userFrameRepo.ownedFrameIds(viewer?.userId, [frame.id]);
  const data     = frame.toJSON();
  data.owned     = ownedIds.has(frame.id);
  data.is_locked = Boolean(data.is_premium) && !data.owned;
  if (!data.owned) delete data.content;
  return data;
}

// ---- Ownership ----

async function listMine(userId) {
  return userFrameRepo.findMine(userId);
}

// Shared loader for the two acquisition paths: the frame must exist and be on
// sale, and we need whatever ownership row already exists for it.
async function _frameAndOwnership(uid, userId) {
  const frame = await frameRepo.findActiveByUid(uid);
  if (!frame) throw new NotFoundError('Frame not found');
  const owned = await userFrameRepo.findForUserAndFrame(userId, frame.id);
  return { frame, owned };
}

// "+" on a free frame. Also the re-add path for a frame that was bought and later
// removed: the row is still there with acquired_via='purchase', so putting it
// back on the shelf costs nothing. That is the whole reason removal keeps the row.
async function addFrame(uid, userId) {
  const { frame, owned } = await _frameAndOwnership(uid, userId);

  if (owned?.status === 'active')  throw new ConflictError('This frame is already in My Frames');
  if (owned?.status === 'pending') throw new ConflictError('A purchase of this frame is awaiting payment');

  const alreadyPaid = owned?.acquired_via === 'purchase';
  if (Number(frame.is_premium) === 1 && !alreadyPaid) {
    throw new ForbiddenError('This is a premium frame — purchase it to add it to My Frames');
  }

  if (owned) {
    await userFrameRepo.update(owned.id, { status: 'active' });
    return userFrameRepo.findById(owned.id);
  }
  return userFrameRepo.create({
    uid:          uuid(),
    user_id:      userId,
    frame_id:     frame.id,
    acquired_via: 'free',
    status:       'active',
    acquired_at:  new Date(),
  });
}

// Buy a premium frame. The ownership row is written up front as 'pending' with
// the payment attached and flips to 'active' when Razorpay confirms — the same
// shape a pending subscription uses, which is what lets the existing webhook
// fulfil this without knowing anything about frames.
async function purchaseFrame(uid, userId) {
  const { frame, owned } = await _frameAndOwnership(uid, userId);

  if (Number(frame.is_premium) !== 1) throw new ValidationError('This frame is free — add it instead of buying it');
  if (owned?.status === 'active')     throw new ConflictError('You already own this frame');
  // Bought once, removed, now buying again: give it back rather than charge twice.
  if (owned?.acquired_via === 'purchase' && owned.status === 'removed') {
    await userFrameRepo.update(owned.id, { status: 'active' });
    return { type: 'already_owned', frame_uid: frame.uid };
  }

  const amountBeforeTax            = parseFloat(frame.price);
  const { gstAmount, totalAmount } = withGst(amountBeforeTax);

  const order   = await razorpay.createOrder(totalAmount, 'INR', `frame_${Date.now()}`);
  const payment = await paymentRepo.create({
    uid:               uuid(),
    user_id:           userId,
    subscription_id:   null,
    order_type:        'one_time',
    purchase_type:     'frame',
    amount:            totalAmount,
    amount_before_tax: amountBeforeTax,
    gst_amount:        gstAmount,
    razorpay_order_id: order.id,
    status:            'pending',
  });

  // Re-purchase after an abandoned attempt reuses the row (the unique index
  // allows only one), repointing it at the new payment.
  if (owned) {
    await userFrameRepo.update(owned.id, {
      acquired_via: 'purchase', payment_id: payment.id, status: 'pending',
    });
  } else {
    await userFrameRepo.create({
      uid:          uuid(),
      user_id:      userId,
      frame_id:     frame.id,
      acquired_via: 'purchase',
      payment_id:   payment.id,
      status:       'pending',
    });
  }

  return {
    type:        'one_time',
    order_id:    order.id,
    amount:      totalAmount,
    currency:    'INR',
    payment_uid: payment.uid,
    frame_uid:   frame.uid,
  };
}

// Called by the payment layer once a one-time payment with no subscription behind
// it succeeds. Idempotent: a payment whose row is already active (webhook and
// client callback both landed) is a no-op, and a payment that bought nothing
// frame-shaped is simply ignored.
async function fulfilPayment(payment) {
  const row = await userFrameRepo.findByPaymentId(payment.id);
  if (!row) return { ignored: 'not a frame purchase' };
  if (row.status === 'active') return { ok: true, idempotent: true };

  await userFrameRepo.update(row.id, { status: 'active', acquired_at: new Date() });
  return { ok: true };
}

// Take a frame off the shelf. The row is kept (status='removed') so a paid frame
// can be re-added without paying again; there is no refund, deliberately.
async function removeFrame(uid, userId) {
  const frame = await frameRepo.findOne({ uid });
  if (!frame) throw new NotFoundError('Frame not found');

  const owned = await userFrameRepo.findForUserAndFrame(userId, frame.id);
  if (!owned || owned.status !== 'active') throw new NotFoundError('This frame is not in My Frames');

  await userFrameRepo.update(owned.id, { status: 'removed' });
}

// Guard for businesses.active_frame_id: you may only apply a frame you own.
// Mirrors fontService.assertUsable — without it a crafted id would mount any
// frame in the catalogue, paid ones included.
async function assertUsable(frameId, userId) {
  if (frameId === undefined) return undefined;
  if (frameId === null || frameId === '') return null;   // clearing the active frame

  const owned = await userFrameRepo.findForUserAndFrame(userId, frameId);
  if (!owned || owned.status !== 'active') {
    throw new ValidationError('Validation failed', [
      { field: 'active_frame_id', message: 'You can only apply a frame from My Frames' },
    ]);
  }
  return frameId;
}

// ---- Admin ----

const STATUSES = ['draft', 'active', 'inactive'];

// Admin browse: every status (filterable), name search, paged. Each row carries
// `missing_for_publish` — the same list the gate would throw — so the panel can
// render an "incomplete" column and a publish checklist without a request per row.
async function listFramesForAdmin(filters = {}) {
  const where = {};
  if (STATUSES.includes(filters.status))        where.status     = filters.status;
  if (FRAME_TYPES.includes(filters.frame_type)) where.frame_type = filters.frame_type;
  if (filters.is_premium !== undefined) where.is_premium = Number(filters.is_premium) ? 1 : 0;

  const categoryId = parseInt(filters.category_id, 10);
  if (Number.isInteger(categoryId) && categoryId > 0) where.category_id = categoryId;
  if (filters.search) where.name = { [Op.like]: `%${filters.search}%` };

  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const { rows, count } = await frameRepo.findForAdmin(where, { limit, offset });

  return {
    count,
    rows: rows.map((row) => {
      const f = row.toJSON();
      f.missing_for_publish = framePublish.missingFromSignals(f);
      f.is_publishable      = f.missing_for_publish.length === 0;
      return f;
    }),
  };
}

module.exports = {
  listStore, listCategories, getFrame,
  listMine, addFrame, purchaseFrame, removeFrame, fulfilPayment, assertUsable,
  listFramesForAdmin,
};
