'use strict';

/**
 * Lets a session revoke its own ACCESS token, so "log out" and "log out
 * everywhere else" take effect immediately.
 *
 * The problem: `user_sessions.jti` is the REFRESH token's id. Revoking a session
 * stops it minting new access tokens, but any access token already in the wild
 * keeps working until it expires (15 minutes). For a security action — logging
 * out a device you no longer trust — a 15 minute grace period is the wrong
 * answer.
 *
 * The obvious fix is to check the session on every authenticated request, but
 * that is a DB read on every request forever, on a host with little headroom.
 * Instead: record the access token this session issued. Revoking the session then
 * adds that jti to `token_blacklist`, and the blacklist lookup `authenticate`
 * ALREADY performs rejects it on the very next call. Instant, and nothing extra
 * on the hot path.
 *
 * `access_expires_at` is the token's own exp, captured at signing. It bounds the
 * blacklist row so it can be purged on schedule (and lets revoke skip tokens that
 * have already expired, which need no blacklisting at all).
 *
 * Both are nullable: sessions created before this migration have no recorded
 * access token, and revoking them simply falls back to the old behaviour.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('user_sessions', 'access_jti', {
      type: Sequelize.UUID,
      allowNull: true,
    });
    await queryInterface.addColumn('user_sessions', 'access_expires_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('user_sessions', 'access_expires_at');
    await queryInterface.removeColumn('user_sessions', 'access_jti');
  },
};
