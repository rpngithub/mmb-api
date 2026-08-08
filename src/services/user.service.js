const bcrypt      = require('bcryptjs');
const userRepo    = require('../repositories/user.repository');
const billingRepo = require('../repositories/userBillingDetail.repository');
const userUpload  = require('./userUpload.service');
const sessionService = require('./session.service');
const { Op } = require('sequelize');
const { Business, UserPreference, Language, User } = require('../models');
const { NotFoundError, ConflictError, ValidationError } = require('../errors');

// The password hash must never leave the server, not even back to its own owner —
// handing it out turns a session hijack into an offline cracking job. Applied to
// every read that returns a user to a client.
const SAFE_ATTRS = { exclude: ['password_hash'] };

const findSafe = (userId) => userRepo.findById(userId, { attributes: SAFE_ATTRS });

// Where the signup flow stands, so the app knows which screen to resume on.
// Derived rather than stored: `completed` is the stamp, and `has_business`
// distinguishes a BUSINESS account still mid-flow from a finished one.
async function onboardingState(user) {
  const hasBusiness = user.account_type === 'business'
    ? (await Business.count({ where: { user_id: user.id, is_active: 1 } })) > 0
    : false;
  return {
    account_type: user.account_type,
    has_business: hasBusiness,
    completed:    Boolean(user.onboarding_completed_at),
  };
}

async function getProfile(userId) {
  const user = await findSafe(userId);
  if (!user) throw new NotFoundError('User not found');

  // `has_password` tells the app whether to offer "Set password" or "Change
  // password". Most accounts are OTP-only and have none. The hash itself is
  // excluded from this read, so it is fetched separately as a boolean.
  const withHash = await userRepo.findById(userId, { attributes: ['password_hash'] });

  return {
    ...user.toJSON(),
    has_password: Boolean(withHash && withHash.password_hash),
    onboarding:   await onboardingState(user),
  };
}

async function updateProfile(userId, data) {
  const user = await userRepo.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  if (data.account_type !== undefined) {
    // Settable only while the flow is open — that window covers the in-flow
    // "SWITCH TO PERSONAL" button and the back arrow. Once onboarding is stamped
    // the answer is frozen, because switching afterwards would strand a business
    // (and its industry, keywords and logo) behind an account that no longer has
    // one. Re-sending the SAME value is a harmless no-op, so it is allowed.
    if (user.onboarding_completed_at && data.account_type !== user.account_type) {
      throw new ConflictError('Account type cannot be changed after signup');
    }
  }

  const patch = { ...data };

  // Verify the photo is one this caller uploaded to their own profile slot.
  if (patch.profile_photo_s3_key !== undefined) {
    patch.profile_photo_s3_key = await userUpload.assertOwnedKey(patch.profile_photo_s3_key, 'profile_photo', userId);
  }

  // A PERSONAL account has nothing further to answer — no industry, no business —
  // so choosing it finishes onboarding on the spot.
  if (patch.account_type === 'personal' && !user.onboarding_completed_at) {
    patch.onboarding_completed_at = new Date();
  }

  await userRepo.update(userId, patch);

  // Replacing or clearing the photo orphans the old file — delete it and refund
  // the storage. After the write, so a storage hiccup cannot undo the save.
  if (patch.profile_photo_s3_key !== undefined) {
    await userUpload.releaseReplaced(user.profile_photo_s3_key, patch.profile_photo_s3_key, userId);
  }

  return getProfile(userId);
}

// Changing a password is how someone reacts to a suspected compromise, so it ends
// every OTHER session. The caller's own device stays signed in — logging someone
// out of the screen they are standing on is hostile, and it is the one session we
// know is legitimate.
async function changePassword(userId, { current_password, new_password }, currentSessionUid = null) {
  const user = await userRepo.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  // OTP-only accounts have no password to compare against; bcrypt.compare would
  // throw on the null hash. Point them at the set-password endpoint instead.
  if (!user.password_hash) {
    throw new ValidationError('This account signs in with OTP and has no password set. Use POST /users/me/password to set one.');
  }

  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) throw new ConflictError('Current password is incorrect');

  await userRepo.update(userId, { password_hash: await bcrypt.hash(new_password, 10) });
  const revoked = await sessionService.revokeOthers('user', userId, currentSessionUid, 'pwd_change');
  return { sessions_ended: revoked };
}

// First password for an OTP-only account. Separate from changePassword because
// there is no current password to prove — the proof is the live session, which is
// itself the product of an OTP. Refuses when one already exists so it can never be
// used to overwrite a password without knowing the old one.
async function setPassword(userId, { new_password }, currentSessionUid = null) {
  const user = await userRepo.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  if (user.password_hash) {
    throw new ConflictError('This account already has a password. Use PATCH /users/me/password to change it.');
  }

  await userRepo.update(userId, { password_hash: await bcrypt.hash(new_password, 10) });
  const revoked = await sessionService.revokeOthers('user', userId, currentSessionUid, 'pwd_change');
  return { sessions_ended: revoked };
}

// Self-service deactivation. Reversible by an admin: nothing is deleted, the
// account is just switched off. Every session ends — including the caller's own,
// since they are closing the account they are using — and auth.service refuses
// both OTP login and refresh for an inactive account, so it stays closed.
async function deactivate(userId) {
  const user = await userRepo.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  await userRepo.update(userId, { is_active: 0 });
  const revoked = await sessionService.revokeAll('user', userId, 'revoked');
  return { sessions_ended: revoked };
}

// ---- Preferences ----

// Applied when a user has never saved any, so the settings screen has something
// to render without a row having to exist. Mirrors the column defaults.
const PREFERENCE_DEFAULTS = {
  notify_push:     1,
  notify_email:    1,
  notify_whatsapp: 1,
};

// What a user who has never opened "Preferred Languages" is treated as. Stored as
// NO ROWS rather than as an English row, so "never chose" stays distinguishable
// from "deliberately chose English only" — which matters the day the default
// changes, or if we ever want to prompt people who haven't picked.
const DEFAULT_LANGUAGE_CODES = ['en'];

const NOTIFY_KEYS = ['notify_push', 'notify_email', 'notify_whatsapp'];

const LANGUAGE_ATTRS = ['id', 'uid', 'code', 'name', 'native_name'];

// The languages a user's browse feed is narrowed to. Falls back to the default
// when they have chosen none — callers can therefore use this directly as a
// filter without special-casing the empty set.
async function effectiveLanguages(userId) {
  const chosen = userId == null ? [] : await Language.findAll({
    attributes: LANGUAGE_ATTRS,
    where:      { is_active: 1 },
    include:    [{ model: User, attributes: [], through: { attributes: [] }, where: { id: userId }, required: true }],
    order:      [['display_order', 'ASC'], ['name', 'ASC']],
  });
  if (chosen.length) return { languages: chosen, is_default: false };

  const fallback = await Language.findAll({
    attributes: LANGUAGE_ATTRS,
    where:      { code: DEFAULT_LANGUAGE_CODES, is_active: 1 },
    order:      [['display_order', 'ASC']],
  });
  return { languages: fallback, is_default: true };
}

async function shapePreferences(userId, row) {
  const { languages, is_default } = await effectiveLanguages(userId);
  return {
    // Content languages — which templates this user is shown. NOT the app's UI
    // language. `languages_are_default` tells the client the user has not
    // actually chosen yet, so it can prompt rather than show a filled-in screen.
    languages:            languages.map((l) => l.toJSON()),
    languages_are_default: is_default,
    notify_push:     Boolean(row ? row.notify_push     : PREFERENCE_DEFAULTS.notify_push),
    notify_email:    Boolean(row ? row.notify_email    : PREFERENCE_DEFAULTS.notify_email),
    notify_whatsapp: Boolean(row ? row.notify_whatsapp : PREFERENCE_DEFAULTS.notify_whatsapp),
  };
}

async function getPreferences(userId) {
  return shapePreferences(userId, await UserPreference.findOne({ where: { user_id: userId } }));
}

// Resolves the client's language refs (code, uid or numeric id) to ids. Unknown or
// deactivated languages are a clean 400 naming them rather than a silent drop —
// quietly ignoring one would leave the user's feed filtered by something other
// than what the screen shows.
async function resolveLanguages(refs) {
  const list    = Array.isArray(refs) ? refs : [refs];
  const ids     = [];
  const unknown = [];

  for (const raw of list) {
    const ref = String(raw).trim();
    if (!ref) continue;
    const where = /^\d+$/.test(ref) ? { id: Number(ref) } : { [Op.or]: [{ code: ref }, { uid: ref }] };
    const row   = await Language.findOne({ where: { ...where, is_active: 1 }, attributes: ['id'] });
    if (row) ids.push(row.id);
    else unknown.push(ref);
  }

  if (unknown.length) {
    throw new ValidationError('Validation failed', unknown.map((code) => ({
      field: 'languages', message: `"${code}" is not an available language`,
    })));
  }
  return [...new Set(ids)];
}

// Partial update — only the keys sent are touched; the row is created on first
// write so users who never open this screen cost nothing. `languages` is a FULL
// REPLACE of the set (it is a multi-select), and `[]` resets to the default.
async function updatePreferences(userId, data) {
  if (data.languages !== undefined) {
    const user = await userRepo.findById(userId);
    if (!user) throw new NotFoundError('User not found');
    await user.setLanguages(await resolveLanguages(data.languages));
  }

  const patch = {};
  for (const key of NOTIFY_KEYS) {
    if (data[key] !== undefined) patch[key] = data[key] ? 1 : 0;
  }

  if (Object.keys(patch).length) {
    const existing = await UserPreference.findOne({ where: { user_id: userId } });
    if (existing) await existing.update(patch);
    else await UserPreference.create({ user_id: userId, ...PREFERENCE_DEFAULTS, ...patch });
  }

  return getPreferences(userId);
}

async function getBilling(userId) {
  return billingRepo.findByUserId(userId);
}

// One billing record per user (user_id is unique) — create or update in place.
async function upsertBilling(userId, data) {
  const existing = await billingRepo.findByUserId(userId);
  if (existing) await billingRepo.update(existing.id, data);
  else await billingRepo.create({ ...data, user_id: userId });
  return billingRepo.findByUserId(userId);
}

module.exports = {
  getProfile, updateProfile, changePassword, setPassword, deactivate,
  getPreferences, updatePreferences, effectiveLanguages,
  getBilling, upsertBilling, onboardingState,
};
