const { v4: uuid } = require('uuid');
const frameRepo    = require('../repositories/userFrame.repository');
const { NotFoundError, ForbiddenError } = require('../errors');

async function _loadOwned(uid, userId) {
  const frame = await frameRepo.findByUid(uid);
  if (!frame) throw new NotFoundError('Frame not found');
  if (frame.user_id !== userId) throw new ForbiddenError('Access denied');
  return frame;
}

async function createFrame(userId, data) {
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
}

module.exports = { createFrame, listFrames, getFrame, updateFrame, deleteFrame };
