const { v4: uuid }  = require('uuid');
const { Op, literal } = require('sequelize');
const frameRepo     = require('../repositories/frame.repository');
const framePublish  = require('./framePublish');
const picker        = require('./templateFamilyPicker');
const userFrameRepo = require('../repositories/userFrame.repository');
const paymentRepo   = require('../repositories/payment.repository');
const { FrameCategory, FrameVersion, TemplateSize, Language } = require('../models');
const { resolveRef, pick } = require('../utils/catalogRef');
const { containsPattern } = require('../utils/textSearch');
// Imported as a namespace, not destructured: the gateway has no test double, so
// the suite swaps this function out at call time.
const razorpay      = require('../utils/razorpayHelper');
const { withGst }     = require('../utils/gst');
const quota         = require('./quota.service');
const { NotFoundError, ForbiddenError, ConflictError, ValidationError } = require('../errors');

const DEFAULT_LIMIT = 30;
const MAX_LIMIT     = 100;
const FRAME_TYPES   = ['static', 'animated'];

// Normalize a resolveRef() result into a filter id: undefined stays undefined
// (param absent → no filter); anything that did not resolve becomes 0 so the
// clause matches NOTHING. A bad category slug must return an empty shelf, never
// the whole store. Same rule the template catalogue follows.
const asFilterId = (resolved) => (resolved === undefined ? undefined : (resolved > 0 ? resolved : 0));

const FRAME  = '`Frame`.`id`';
const SOURCE = picker.FRAME_SOURCE;

// A switched-off category takes its frames out of the store. They are not
// unpublished — owners keep them, and switching the category back restores them.
const IN_ACTIVE_CATEGORY = literal(
  'EXISTS (SELECT 1 FROM `frame_categories` c WHERE c.id = `Frame`.`category_id` AND c.is_active = 1)',
);

// What a card or detail says about one version. Never the design payload.
// `asset_prefix` is the folder the version's design resolves bare filenames against
// (its bundle, see frameBundle.service) — the frame's own uid is NOT that folder.
const versionSummary = (v) => (v ? {
  id: v.id, uid: v.uid, language_id: v.language_id, size_id: v.size_id,
  thumbnail_s3_key: v.thumbnail_s3_key, asset_prefix: `frames/${v.uid}/`,
  updated_at: v.updated_at, Language: v.Language || null, TemplateSize: v.TemplateSize || null,
} : null);

// Frame fields plus the version picked for the viewer. `thumbnail_s3_key` stays at
// the top level (the picked version's) so a grid keeps reading the field it always did.
function withPick(frame, pickResult) {
  const f = typeof frame.toJSON === 'function' ? frame.toJSON() : { ...frame };
  f.thumbnail_s3_key    = pickResult?.version?.thumbnail_s3_key ?? null;
  f.version             = versionSummary(pickResult?.version);
  f.available_languages = pickResult?.available_languages || [];
  f.available_sizes     = pickResult?.available_sizes || [];
  return f;
}

// The store card. `owned` drives the tick on the card, `is_locked` the price
// badge: a premium frame the viewer has not bought yet. Guests own nothing, so
// every premium frame reads as locked to them.
function toCard(row, pickResult, ownedIds) {
  const f = withPick(row, pickResult);
  f.owned     = ownedIds.has(f.id);
  f.is_locked = Boolean(f.is_premium) && !f.owned;
  return f;
}

// ---- Store ----

// The frames store. Unlike the template catalogue this needs no mandatory anchor:
// the whole shelf is small and curated, and the design opens on "all frames of
// this tab" before any chip is tapped.
//
// Frames are families (migration 058) and the store follows the template rules
// (templateFamilyPicker): a frame shows only with an active version in one of the
// viewer's languages, or a text-free one — and, with `size`, in that size — and
// the card shows the version in their top language, then the default size.
async function listStore(filters = {}, viewer = null) {
  const categoryId = asFilterId(await resolveRef(FrameCategory, pick(filters.category, filters.category_id)));
  const sizeId     = asFilterId(await resolveRef(TemplateSize, pick(filters.size, filters.size_id)));

  const where = { status: 'active' };
  if (categoryId !== undefined) where.category_id = categoryId;
  if (FRAME_TYPES.includes(filters.frame_type)) where.frame_type = filters.frame_type;
  if (filters.is_premium !== undefined) where.is_premium = Number(filters.is_premium) ? 1 : 0;

  const languageIds = await picker.resolveLanguageRank(filters, viewer);
  where[Op.and] = [IN_ACTIVE_CATEGORY, picker.versionMatchClause(FRAME, { languageIds, sizeId, source: SOURCE })];

  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const { rows, count } = await frameRepo.findForStore(where, { limit, offset });
  const ids = rows.map((r) => r.id);
  const [ownedIds, picks] = await Promise.all([
    userFrameRepo.ownedFrameIds(viewer?.userId, ids),
    picker.pickVersions(ids, { languageIds, sizeId, defaultSize: await picker.defaultSizeId(), source: SOURCE }),
  ]);

  // The SQL clause guarantees every row has a pick; the filter only guards a
  // version unpublished between the two queries.
  const items = rows.filter((r) => picks.has(r.id)).map((row) => toCard(row, picks.get(row.id), ownedIds));
  return { total: count, items };
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
//
// Which version: the editor passes the poster it is framing — `size` (slug, uid
// or id) and optionally `language` — and gets that version. SIZE IS STRICT: a
// frame drawn for 4:5 does not fit a 1:1 poster, so when the frame has no version
// in the asked size `version` is null and no content is sent (the client offers
// another frame). Language falls back: an English frame over a Tamil poster is
// usable. Without `size` the version is picked as a store card would be, never
// hidden. `versions` always lists every active version for a switcher.
async function getFrame(uid, viewer = null, filters = {}) {
  const frame = await frameRepo.findActiveByUid(uid);
  if (!frame) throw new NotFoundError('Frame not found');

  const ownedIds = await userFrameRepo.ownedFrameIds(viewer?.userId, [frame.id]);
  const owned    = ownedIds.has(frame.id);

  const sizeRef     = pick(filters.size, filters.size_id);
  const sizeId      = sizeRef === undefined ? undefined : asFilterId(await resolveRef(TemplateSize, sizeRef));
  const languageIds = await picker.resolveLanguageRank(filters, viewer);
  const base        = { defaultSize: await picker.defaultSizeId(), withContent: owned, source: SOURCE };

  let chosen;
  if (sizeId === undefined) {
    chosen = (await picker.pickVersions([frame.id], { ...base, languageIds, hide: false })).get(frame.id);
  } else {
    // The viewer's languages in that size, else any language in that size.
    chosen = (await picker.pickVersions([frame.id], { ...base, languageIds, sizeId })).get(frame.id)
      || (await picker.pickVersions([frame.id], { ...base, languageIds: null, sizeId })).get(frame.id);
  }
  // The full version list (and what the frame comes in) whatever was picked.
  const all = chosen || (await picker.pickVersions([frame.id], { ...base, withContent: false, hide: false })).get(frame.id);

  const data = withPick(frame, chosen ? { ...all, version: chosen.version } : { ...all, version: null });
  if (!chosen && all?.version) data.thumbnail_s3_key = all.version.thumbnail_s3_key;
  data.versions  = (all ? all.versions : []).map(versionSummary);
  data.owned     = owned;
  data.is_locked = Boolean(data.is_premium) && !owned;
  if (owned && chosen) data.content = chosen.version.content;
  return data;
}

// ---- Ownership ----

// My Frames, each with what it comes in and the thumbnail a card would show.
async function listMine(userId, viewer = null) {
  const rows = await userFrameRepo.findMine(userId);
  const ids  = rows.map((r) => r.frame_id);
  const picks = await picker.pickVersions(ids, {
    languageIds: await picker.resolveLanguageRank({}, viewer || { userId }),
    defaultSize: await picker.defaultSizeId(),
    hide:        false,
    source:      SOURCE,
  });
  return rows.map((row) => {
    const data = row.toJSON();
    if (data.Frame) data.Frame = withPick(data.Frame, picks.get(row.frame_id));
    return data;
  });
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

  // The plan's frame allowance covers free adds only. A frame bought outright was
  // paid for per frame, so the plan cap never stands between a user and it.
  if (alreadyPaid) {
    await userFrameRepo.update(owned.id, { status: 'active' });
    return userFrameRepo.findById(owned.id);
  }

  await quota.assertWithinQuota(userId, 'frames');

  let row;
  if (owned) {
    await userFrameRepo.update(owned.id, { status: 'active' });
    row = await userFrameRepo.findById(owned.id);
  } else {
    row = await userFrameRepo.create({
      uid:          uuid(),
      user_id:      userId,
      frame_id:     frame.id,
      acquired_via: 'free',
      status:       'active',
      acquired_at:  new Date(),
    });
  }

  await quota.consume(userId, 'frames', 1, { source: 'frame_add', ref_type: 'user_frame', ref_id: row.id });
  return row;
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

const toPosInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Admin browse: every status (filterable), name search, paged. Each row carries
// `missing_for_publish` — the same list the gate would throw — so the panel can
// render an "incomplete" column and a publish checklist without a request per row,
// plus what the frame comes in (version counts, languages, sizes, a thumbnail).
async function listFramesForAdmin(filters = {}) {
  const where = {};
  if (STATUSES.includes(filters.status))        where.status     = filters.status;
  if (FRAME_TYPES.includes(filters.frame_type)) where.frame_type = filters.frame_type;
  if (filters.is_premium !== undefined) where.is_premium = Number(filters.is_premium) ? 1 : 0;

  const categoryId = toPosInt(filters.category_id);
  if (categoryId) where.category_id = categoryId;
  if (filters.search) where.name = { [Op.like]: containsPattern(filters.search) };

  // Frames of one version — what migration 058 left behind — for merging by eye.
  if (toPosInt(filters.single_version)) {
    where[Op.and] = [literal(`(SELECT COUNT(*) FROM \`frame_versions\` v WHERE v.frame_id = ${FRAME}) = 1`)];
  }

  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const { rows, count } = await frameRepo.findForAdmin(where, { limit, offset });

  const ids = rows.map((r) => r.id);
  const versions = ids.length ? await FrameVersion.findAll({
    where:      { frame_id: { [Op.in]: ids } },
    attributes: ['id', 'uid', 'frame_id', 'language_id', 'size_id', 'thumbnail_s3_key', 'status'],
    include:    [
      { model: Language,     attributes: picker.LANGUAGE_ATTRS },
      { model: TemplateSize, attributes: picker.SIZE_ATTRS },
    ],
    order: [['id', 'ASC']],
  }) : [];
  const byFrame = new Map(ids.map((id) => [id, []]));
  for (const v of versions) byFrame.get(v.frame_id).push(v.toJSON());

  const defaultSize = await picker.defaultSizeId();
  return {
    count,
    rows: rows.map((row) => {
      const f   = row.toJSON();
      const own = byFrame.get(row.id) || [];
      const thumb = own.find((v) => v.size_id === defaultSize && (v.language_id === null || v.Language?.code === 'en') && v.thumbnail_s3_key)
        || own.find((v) => v.thumbnail_s3_key) || null;
      f.languages           = [...new Map(own.filter((v) => v.Language).map((v) => [v.Language.id, v.Language])).values()];
      f.sizes               = [...new Map(own.filter((v) => v.TemplateSize).map((v) => [v.TemplateSize.id, v.TemplateSize])).values()];
      f.text_free           = own.length > 0 && own.every((v) => v.language_id === null);
      f.thumbnail_s3_key    = thumb ? thumb.thumbnail_s3_key : null;
      f.missing_for_publish = framePublish.missingFromSignals(f);
      f.is_publishable      = f.missing_for_publish.length === 0;
      return f;
    }),
  };
}

// Admin detail: the frame with its versions (no content) and the same readiness the
// list carries, so the Publish card shows the server's rule rather than re-deriving it.
async function getFrameForAdmin(uid) {
  const frame = await frameRepo.model.findOne({
    where:      { uid },
    attributes: { include: [framePublish.requiredVersionAttr(FRAME)] },
    include:    [
      { model: FrameCategory },
      {
        model: FrameVersion, as: 'versions', attributes: { exclude: ['content'] },
        include: [
          { model: Language,     attributes: picker.LANGUAGE_ATTRS },
          { model: TemplateSize, attributes: picker.SIZE_ATTRS },
        ],
      },
    ],
    order: [[{ model: FrameVersion, as: 'versions' }, 'id', 'ASC']],
  });
  if (!frame) throw new NotFoundError('frame not found');

  const f = frame.toJSON();
  f.missing_for_publish = framePublish.missingFromSignals(f);
  f.is_publishable      = f.missing_for_publish.length === 0;
  return f;
}

// Admin browse of one frame's versions (or all), every status, `content` excluded;
// completeness flags mirror the version publish gate.
async function listVersionsForAdmin(filters = {}) {
  const where = {};
  if (STATUSES.includes(filters.status)) where.status = filters.status;

  const frameId = toPosInt(filters.frame_id);
  if (frameId) where.frame_id = frameId;
  if (filters.frame_uid) {
    const frame = await frameRepo.findOne({ uid: filters.frame_uid }, { attributes: ['id'] });
    where.frame_id = frame ? frame.id : 0;
  }
  if (filters.language_id === 'null') where.language_id = null;
  else if (toPosInt(filters.language_id)) where.language_id = toPosInt(filters.language_id);
  if (toPosInt(filters.size_id)) where.size_id = toPosInt(filters.size_id);

  const limit  = Math.min(parseInt(filters.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  return FrameVersion.findAndCountAll({
    where,
    attributes: {
      exclude: ['content'],
      include: [
        [literal("(`FrameVersion`.`content` IS NOT NULL AND `FrameVersion`.`content` <> '')"), 'has_content'],
        [literal("(`FrameVersion`.`thumbnail_s3_key` IS NOT NULL AND `FrameVersion`.`thumbnail_s3_key` <> '')"), 'has_thumbnail'],
      ],
    },
    include: [
      { model: frameRepo.model, attributes: ['id', 'uid', 'name', 'status'] },
      { model: Language,        attributes: picker.LANGUAGE_ATTRS },
      { model: TemplateSize,    attributes: picker.SIZE_ATTRS },
    ],
    order: [['id', 'DESC']],
    limit,
    offset,
  });
}

module.exports = {
  listStore, listCategories, getFrame,
  listMine, addFrame, purchaseFrame, removeFrame, fulfilPayment, assertUsable,
  listFramesForAdmin, getFrameForAdmin, listVersionsForAdmin,
};
