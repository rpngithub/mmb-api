'use strict';

/**
 * Refresh-token reuse detection.
 *
 * A refresh token is single-use: using it rotates it away. So if an already-used
 * token turns up again, two parties hold the chain — and the likely explanation is
 * that it was stolen. Rejecting just the replayed token is not enough: whoever
 * refreshed FIRST already holds a fresh token and keeps rotating it, while the
 * loser is simply logged out and told nothing. If the thief refreshed first, that
 * is a silent 30-day backdoor.
 *
 * Detecting it needs the replaced token to still be recognisable, which means the
 * session has to rotate IN PLACE rather than revoke-old + insert-new: one row per
 * device, holding both the current refresh token and the one it replaced.
 *
 *   prev_jti / prev_refresh_token_hash — the token this session just replaced.
 *     A refresh presenting THIS instead of `jti` is a replay.
 *   rotated_at — when the swap happened, so a replay arriving moments later can be
 *     treated as an innocent retry (flaky mobile connection, two tabs racing)
 *     rather than theft.
 *
 * All three are nullable: sessions predating this migration simply have no
 * previous token recorded, and behave as before until their first rotation.
 *
 * Rotating in place also stops `user_sessions` gaining a row every 15 minutes per
 * device, and keeps `uid` (the access token's `sid` claim) stable for the life of
 * the login instead of changing on every refresh.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('user_sessions', 'prev_jti', {
      type: Sequelize.UUID,
      allowNull: true,
    });
    await queryInterface.addColumn('user_sessions', 'prev_refresh_token_hash', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.addColumn('user_sessions', 'rotated_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    // Every refresh looks a session up by `jti` OR `prev_jti`; `jti` is already
    // unique-indexed, this covers the other half.
    await queryInterface.addIndex('user_sessions', ['prev_jti'], {
      name: 'user_sessions_prev_jti',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('user_sessions', 'user_sessions_prev_jti');
    await queryInterface.removeColumn('user_sessions', 'rotated_at');
    await queryInterface.removeColumn('user_sessions', 'prev_refresh_token_hash');
    await queryInterface.removeColumn('user_sessions', 'prev_jti');
  },
};
