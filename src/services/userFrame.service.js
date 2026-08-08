const { v4: uuid } = require('uuid');
const frameRepo    = require('../repositories/userFrame.repository');
const userUpload   = require('./userUpload.service');
const { NotFoundError, ForbiddenError } = require('../errors');

async function _loadOwned(uid, userId) {
  const frame = await frameRepo.findByUid(uid);
  if (!frame) throw new NotFoundError('Frame not found');
  if (frame.user_id !== userId) throw new ForbiddenError('Access denied');
  return frame;
}

async function createFrame(userId, data) {
  // The frame file must be one this caller uploaded to their own frames slot.
  await userUpload.assertOwnedKey(data.s3_key, 'user_frame', userId);
  return frameRepo.create({ ...data, uid: uuid(), user_id: userId });
}

async function listFrames(userId) {
  return frameRepo.findMyFrames(userId);
}

async function getFrame(uid, userId) {
  return _loadOwned(uid, userId);
}

async function updateFrame(uid, userId, data) {
  const frame = await _loadOwned(uid, userId);
  await frameRepo.update(frame.id, data);
  return frameRepo.findByUid(uid);
}

async function deleteFrame(uid, userId) {
  const frame = await _loadOwned(uid, userId);
  await frameRepo.update(frame.id, { is_active: 0 });
  // The row stays (soft delete) but the file is gone and its storage is refunded —
  // a frame the user can no longer see or use should not keep costing them quota.
  await userUpload.release(frame.s3_key, userId);
}

module.exports = { createFrame, listFrames, getFrame, updateFrame, deleteFrame };
