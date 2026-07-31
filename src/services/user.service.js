const bcrypt     = require('bcryptjs');
const userRepo   = require('../repositories/user.repository');
const billingRepo = require('../repositories/userBillingDetail.repository');
const { NotFoundError, ConflictError } = require('../errors');

async function getProfile(userId) {
  const user = await userRepo.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  return user;
}

async function updateProfile(userId, data) {
  await userRepo.update(userId, data);
  return userRepo.findById(userId);
}

async function changePassword(userId, { current_password, new_password }) {
  const user = await userRepo.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) throw new ConflictError('Current password is incorrect');

  const hash = await bcrypt.hash(new_password, 10);
  await userRepo.update(userId, { password_hash: hash });
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

module.exports = { getProfile, updateProfile, changePassword, getBilling, upsertBilling };
