'use strict';

/**
 * Lets a revoke reach the access token a device held BEFORE its last refresh.
 *
 * A session records the access token it issued (`access_jti`) so revoking it can
 * blacklist that token and take effect immediately rather than 15 minutes later.
 * But rotation overwrites it — and the client is still holding the previous access
 * token, valid for the remainder of its 15 minutes. So "log out my other devices"
 * and "deactivate my account" left that one working, which for a security action is
 * the wrong answer twice over: the user was told every device was signed out.
 *
 * (Logout was never affected: it blacklists whichever token the caller presented,
 * on top of the session's.)
 *
 * Recording the outgoing pair alongside `prev_jti` closes it. Two tokens is all that
 * is ever needed: anything older than the previous access token has already expired,
 * because a rotation only happens when the current one is at or near its 15-minute
 * life.
 *
 * Both nullable: sessions that predate this, or that have never rotated, simply have
 * nothing previous to revoke.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('user_sessions', 'prev_access_jti', {
      type: Sequelize.UUID,
      allowNull: true,
    });
    await queryInterface.addColumn('user_sessions', 'prev_access_expires_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('user_sessions', 'prev_access_expires_at');
    await queryInterface.removeColumn('user_sessions', 'prev_access_jti');
  },
};
