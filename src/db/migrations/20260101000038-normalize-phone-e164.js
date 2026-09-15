'use strict';

/**
 * Rewrites every login phone to E.164 (`+91XXXXXXXXXX`) and resolves the duplicate
 * accounts that the old raw storage produced.
 *
 * The Flutter app sends `+919876543210`, the web app sends `9876543210`, and
 * `users.phone` is a plain unique string. Nothing normalised it, so the same
 * handset that signed up on mobile got a SECOND, empty account when it logged in
 * on web — "my profile is missing". The code now canonicalises through
 * utils/phone.js; this migration brings the rows that pre-date it into line.
 *
 * Collisions — the same number already present in two spellings — cannot both be
 * rewritten (unique index), and merging two accounts' data is not something to do
 * blind. So one row wins and the other is PARKED, not deleted: phone set to NULL
 * (the unique index allows any number of NULLs), is_active = 0, sessions revoked.
 * Everything the parked row owns stays attached to it for manual inspection.
 * Winner = the row that finished onboarding, else the one owning an active
 * business, else the older one. Every collision is logged, and a parked row that
 * holds an active subscription is called out loudly — that one is worth a look.
 *
 * `down` is a no-op. The original spellings are not recoverable, and E.164 rows
 * are harmless to older code: it stored whatever the client sent, so it would
 * simply keep doing that.
 */
const { toE164 } = require('../../utils/phone');

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;

    // ---- users ---------------------------------------------------------------
    const [users] = await q.query(
      `SELECT u.id, u.phone, u.created_at, u.onboarding_completed_at,
              EXISTS(SELECT 1 FROM businesses b WHERE b.user_id = u.id AND b.is_active = 1)            AS has_business,
              EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id = u.id AND s.status = 'active') AS has_subscription
         FROM users u
        WHERE u.phone IS NOT NULL`,
    );

    // Group by canonical number. A row whose phone is not an Indian mobile at all
    // (test fixtures, hand-entered junk) has no canonical form and is left as is.
    const byCanonical = new Map();
    for (const u of users) {
      const canonical = toE164(u.phone);
      if (!canonical) continue;
      if (!byCanonical.has(canonical)) byCanonical.set(canonical, []);
      byCanonical.get(canonical).push(u);
    }

    const rank = (u) => [
      u.onboarding_completed_at ? 1 : 0,
      Number(u.has_business),
      -u.id,                                   // older row wins the final tie
    ];
    const better = (a, b) => {
      const ra = rank(a), rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i] ? a : b;
      return a;
    };

    for (const [canonical, rows] of byCanonical) {
      const winner = rows.reduce(better);

      for (const loser of rows) {
        if (loser === winner) continue;
        console.log(
          `[migrate 000038] ${canonical}: keeping user ${winner.id} (${winner.phone}), parking user ${loser.id} (${loser.phone})`
          + (Number(loser.has_subscription) ? ' — WARNING: parked row holds an ACTIVE SUBSCRIPTION' : ''),
        );
        await q.query('UPDATE users SET phone = NULL, is_active = 0 WHERE id = :id', { replacements: { id: loser.id } });
        await q.query(
          "UPDATE user_sessions SET is_revoked = 1 WHERE actor_type = 'user' AND actor_id = :id AND is_revoked = 0",
          { replacements: { id: loser.id } },
        );
      }

      if (winner.phone !== canonical) {
        await q.query('UPDATE users SET phone = :phone WHERE id = :id', { replacements: { phone: canonical, id: winner.id } });
      }
    }

    // ---- otp_codes -----------------------------------------------------------
    // No unique index here, so a straight rewrite. Only live codes matter — a used
    // or expired row is never looked up again — but rewriting all of them keeps the
    // table consistent for anyone reading it.
    const [otps] = await q.query('SELECT DISTINCT phone FROM otp_codes');
    for (const { phone } of otps) {
      const canonical = toE164(phone);
      if (!canonical || canonical === phone) continue;
      await q.query('UPDATE otp_codes SET phone = :canonical WHERE phone = :phone', { replacements: { canonical, phone } });
    }
  },

  async down() {
    // Intentionally nothing — see the header.
  },
};
