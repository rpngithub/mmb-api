const { Op }       = require('sequelize');
const { v4: uuid } = require('uuid');
const userUpload   = require('./userUpload.service');
const userSubRepo  = require('../repositories/userSubscription.repository');
const { sequelize, Font, FontFile, Language } = require('../models');
const { NotFoundError, ForbiddenError, ValidationError, ConflictError } = require('../errors');

// A font is offered to a viewer when it is a LIBRARY font (user_id null) or one
// they uploaded themselves. That single rule replaces the either/or a separate
// user-font table would have forced on every caller.
const visibleTo = (userId) => (userId
  ? { is_active: 1, [Op.or]: [{ user_id: null }, { user_id: userId }] }
  : { is_active: 1, user_id: null });

const FILE_ATTRS     = ['weight', 'style', 'format', 's3_key'];
const LANGUAGE_ATTRS = ['id', 'uid', 'code', 'name', 'native_name'];

const includes = () => [
  { model: FontFile, attributes: FILE_ATTRS },
  { model: Language, attributes: LANGUAGE_ATTRS, through: { attributes: [] } },
];

// Premium LIBRARY fonts are paid content, gated the same way premium assets are —
// listed so they can be seen, with the files withheld until the viewer upgrades.
// A user's own upload is never premium to them.
const isPaid = (viewer) => viewer?.tier === 'paid';

function shape(font, viewer) {
  const f = font.toJSON();
  f.is_own    = f.user_id != null;
  f.is_locked = Boolean(f.is_premium) && !f.is_own && !isPaid(viewer);
  if (f.is_locked) delete f.FontFiles;      // withhold the files until upgrade
  delete f.user_id;                          // internal
  return f;
}

// `language` narrows to fonts that can actually render that script. Fonts with NO
// declared coverage are always included: an unclassified font is unknown, not
// known-incapable, and hiding it would empty the picker the day someone adds a
// font and forgets to tag it.
async function listFonts({ language } = {}, viewer = null) {
  const userId = viewer?.userId ?? null;
  const where  = visibleTo(userId);

  if (language !== undefined && language !== '') {
    const lang = await Language.findOne({ where: { code: String(language).trim() }, attributes: ['id'] });
    const langId = lang ? lang.id : 0;
    where[Op.and] = [sequelize.literal(
      `(NOT EXISTS (SELECT 1 FROM \`font_languages\` fl WHERE fl.font_id = \`Font\`.\`id\`) `
      + `OR EXISTS (SELECT 1 FROM \`font_languages\` fl WHERE fl.font_id = \`Font\`.\`id\` AND fl.language_id = ${langId}))`,
    )];
  }

  const rows = await Font.findAll({
    where,
    include: includes(),
    order:   [['user_id', 'ASC'], ['display_order', 'ASC'], ['family', 'ASC']],
  });
  return rows.map((r) => shape(r, viewer));
}

// The caller's own upload becomes a Font row so the brand kit can point at it the
// same way it points at a library font. The file must be one THEY uploaded to the
// brand_font slot — otherwise a crafted s3_key could mount someone else's file, or
// a premium library font's, as a private typeface.
async function createOwnFont(userId, { family, files }) {
  const name = family.trim();

  const clash = await Font.findOne({ where: { user_id: userId, family: name } });
  if (clash) throw new ConflictError('You already have a font with this name');

  for (const f of files) await userUpload.assertOwnedKey(f.s3_key, 'brand_font', userId);

  return sequelize.transaction(async (t) => {
    const font = await Font.create({ uid: uuid(), user_id: userId, family: name, is_active: 1 }, { transaction: t });
    await FontFile.bulkCreate(files.map((f) => ({
      font_id: font.id,
      weight:  f.weight || 400,
      style:   f.style  || 'normal',
      format:  f.format,
      s3_key:  f.s3_key,
    })), { transaction: t });

    return Font.findOne({ where: { id: font.id }, include: includes(), transaction: t })
      .then((row) => shape(row, { userId, tier: 'paid' }));
  });
}

// Deleting your own font releases the storage its files occupied. Any business
// using it has the reference nulled by the FK (ON DELETE SET NULL), so it silently
// falls back to the default typeface rather than breaking.
async function deleteOwnFont(uid, userId) {
  const font = await Font.findOne({ where: { uid }, include: [{ model: FontFile, attributes: ['s3_key'] }] });
  if (!font) throw new NotFoundError('Font not found');
  if (font.user_id !== userId) throw new ForbiddenError('Library fonts cannot be deleted');

  const keys = (font.FontFiles || []).map((f) => f.s3_key);
  await font.destroy();                                   // cascades font_files
  for (const key of keys) await userUpload.release(key, userId);
}

// Guard for the brand kit: you may only style a business with a font you can
// actually see, and premium library fonts need the plan behind them.
//
// Entitlement is read from the DB rather than the token's `tier` claim, which
// only refreshes when the token does — a lapsed plan must not keep unlocking
// premium fonts until the user happens to sign in again.
async function assertUsable(fontId, userId) {
  if (fontId === undefined || fontId === null) return;
  const font = await Font.findOne({ where: { id: fontId, ...visibleTo(userId) } });
  if (!font) throw new ValidationError('Unknown font');

  if (font.is_premium && font.user_id == null && !(await userSubRepo.findActiveByUser(userId))) {
    throw new ForbiddenError('This font is available on paid plans');
  }
}

module.exports = { listFonts, createOwnFont, deleteOwnFont, assertUsable, visibleTo };
