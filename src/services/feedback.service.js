const { v4: uuid } = require('uuid');
const { Feedback, User } = require('../models');

// Registered users only — the route is behind `authenticate`, so every row is
// attributable and support has someone to reply to.
async function submit(userId, { rating, message, app_version, platform }) {
  const row = await Feedback.create({
    uid:         uuid(),
    user_id:     userId,
    rating,
    // Trim, and store a whitespace-only note as null rather than as blank text —
    // the admin list should show "no comment", not an empty box.
    message:     message && message.trim() ? message.trim() : null,
    app_version: app_version || null,
    platform:    platform || null,
  });
  return { uid: row.uid, rating: row.rating, created_at: row.created_at };
}

// Admin list, newest first. Mirrors listActivity/listUsers: paginated, filtered,
// and returning { rows, count } so the panel can show a total.
async function listForAdmin({ rating, user_id, limit = 50, offset = 0 } = {}) {
  const where = {};
  const r = parseInt(rating, 10);
  if (r >= 1 && r <= 5) where.rating = r;
  const uid = parseInt(user_id, 10);
  if (uid > 0) where.user_id = uid;

  return Feedback.findAndCountAll({
    where,
    include: [{ model: User, attributes: ['id', 'uid', 'name', 'phone', 'email'] }],
    limit:   Math.min(parseInt(limit, 10) || 50, 200),
    offset:  Math.max(parseInt(offset, 10) || 0, 0),
    order:   [['id', 'DESC']],
  });
}

module.exports = { submit, listForAdmin };
