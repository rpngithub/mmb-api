const uploadService = require('../services/upload.service');
const { hasPermission } = require('../middlewares/authorizeAdmin');
const { ForbiddenError } = require('../errors');

// The upload routes are open to any admin, but a frame version's bundle folder is
// frames content: writing into it needs `frames.update`, the same permission the
// bundle confirm/reset routes need. Checked on the target (presign / initiate) and on
// the key the later multipart steps and confirm send back.
const FRAME_PERMISSION = 'frames.update';

function assertFrameAccess(req, { targets = [], keys = [] }) {
  const touchesFrames = targets.some((t) => t && t.type === 'frame_file')
    || keys.some((k) => uploadService.isFrameBundleKey(k));
  if (touchesFrames && !hasPermission(req.user.permissions, FRAME_PERMISSION)) {
    throw new ForbiddenError(`Missing permission: ${FRAME_PERMISSION}`);
  }
}

const presign = async (req, res) => {
  const targets = Array.isArray(req.body.files) ? req.body.files.map((f) => f.target) : [req.body.target];
  assertFrameAccess(req, { targets });
  res.json({ success: true, data: await uploadService.presign(req.body) });
};

const multipartInitiate = async (req, res) => {
  assertFrameAccess(req, { targets: [req.body.target] });
  res.json({ success: true, data: await uploadService.multipartInitiate(req.body) });
};

const multipartPresignParts = async (req, res) => {
  assertFrameAccess(req, { keys: [req.body.key] });
  res.json({ success: true, data: await uploadService.multipartPresignParts(req.body) });
};

const multipartComplete = async (req, res) => {
  assertFrameAccess(req, { keys: [req.body.key] });
  res.json({ success: true, data: await uploadService.multipartComplete(req.body) });
};

const multipartAbort = async (req, res) => {
  assertFrameAccess(req, { keys: [req.body.key] });
  res.json({ success: true, data: await uploadService.multipartAbort(req.body) });
};

const confirm = async (req, res) => {
  assertFrameAccess(req, { keys: req.body.keys });
  res.json({ success: true, data: await uploadService.confirm(req.body) });
};

module.exports = { presign, multipartInitiate, multipartPresignParts, multipartComplete, multipartAbort, confirm };
