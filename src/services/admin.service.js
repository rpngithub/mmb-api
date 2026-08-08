const bcrypt       = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { Op }       = require('sequelize');
const { AdminUser, Role, User, ActivityLog } = require('../models');
const sessionService = require('./session.service');
const { NotFoundError, ConflictError } = require('../errors');

// ---- Admin users ----
async function listAdmins({ search, limit = 20, offset = 0 } = {}) {
  const where = {};
  if (search) {
    where[Op.or] = [
      { name:  { [Op.like]: `%${search}%` } },
      { email: { [Op.like]: `%${search}%` } },
    ];
  }
  return AdminUser.findAndCountAll({
    where,
    include: [{ model: Role }],
    attributes: { exclude: ['password_hash'] },
    limit:  Math.min(parseInt(limit, 10) || 20, 100),
    offset: Math.max(parseInt(offset, 10) || 0, 0),
    order:  [['id', 'DESC']],
  });
}

async function createAdmin({ name, email, password, role_id }) {
  if (await AdminUser.findOne({ where: { email } })) {
    throw new ConflictError('Admin with this email already exists');
  }
  const password_hash = await bcrypt.hash(password, 10);
  const admin = await AdminUser.create({ uid: uuid(), name, email, password_hash, role_id });
  return AdminUser.findOne({ where: { id: admin.id }, include: [{ model: Role }], attributes: { exclude: ['password_hash'] } });
}

async function getAdmin(adminUid) {
  const admin = await AdminUser.findOne({
    where: { uid: adminUid },
    include: [{ model: Role }],
    attributes: { exclude: ['password_hash'] },
  });
  if (!admin) throw new NotFoundError('Admin not found');
  return admin;
}

async function updateAdmin(adminUid, data) {
  const admin = await AdminUser.findOne({ where: { uid: adminUid } });
  if (!admin) throw new NotFoundError('Admin not found');

  const patch = {};
  if (data.name !== undefined)      patch.name = data.name;
  if (data.role_id !== undefined)   patch.role_id = data.role_id;
  if (data.is_active !== undefined) patch.is_active = data.is_active;
  if (data.password)                patch.password_hash = await bcrypt.hash(data.password, 10);

  await admin.update(patch);
  return AdminUser.findOne({ where: { uid: adminUid }, include: [{ model: Role }], attributes: { exclude: ['password_hash'] } });
}

async function setAdminActive(adminUid, isActive) {
  const admin = await AdminUser.findOne({ where: { uid: adminUid } });
  if (!admin) throw new NotFoundError('Admin not found');
  await admin.update({ is_active: isActive });
  return AdminUser.findOne({ where: { uid: adminUid }, include: [{ model: Role }], attributes: { exclude: ['password_hash'] } });
}

// ---- End-user administration ----
async function listUsers({ search, limit = 20, offset = 0 } = {}) {
  const where = {};
  if (search) {
    where[Op.or] = [
      { name:  { [Op.like]: `%${search}%` } },
      { phone: { [Op.like]: `%${search}%` } },
      { email: { [Op.like]: `%${search}%` } },
    ];
  }
  return User.findAndCountAll({
    where,
    attributes: { exclude: ['password_hash'] },
    limit:  Math.min(parseInt(limit, 10) || 20, 100),
    offset: Math.max(parseInt(offset, 10) || 0, 0),
    order:  [['id', 'DESC']],
  });
}

async function getUser(userUid) {
  const user = await User.findOne({ where: { uid: userUid }, attributes: { exclude: ['password_hash'] } });
  if (!user) throw new NotFoundError('User not found');
  return user;
}

async function setUserActive(userUid, isActive) {
  const user = await User.findOne({ where: { uid: userUid } });
  if (!user) throw new NotFoundError('User not found');
  await user.update({ is_active: isActive });

  // Deactivating from the admin panel is a moderation action, so it must take
  // effect now — not whenever the user's access token happens to expire. This
  // mirrors self-deactivation (user.service#deactivate); without it an admin ban
  // left the account working for up to the access-token lifetime.
  // Reactivating deliberately does NOT revoke: there is nothing to cut off.
  if (!isActive) await sessionService.revokeAll('user', user.id, 'revoked');

  return getUser(userUid);   // re-read without password_hash, as the other user reads do
}

// ---- Audit trail ----
async function listActivity({ entity_type, action, actor_type, limit = 50, offset = 0 } = {}) {
  const where = {};
  if (entity_type) where.entity_type = entity_type;
  if (action)      where.action = action;
  if (actor_type)  where.actor_type = actor_type;
  return ActivityLog.findAndCountAll({
    where,
    limit:  Math.min(parseInt(limit, 10) || 50, 200),
    offset: Math.max(parseInt(offset, 10) || 0, 0),
    order:  [['id', 'DESC']],
  });
}

module.exports = { listAdmins, getAdmin, createAdmin, updateAdmin, setAdminActive, listUsers, getUser, setUserActive, listActivity };
