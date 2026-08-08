'use strict';

/**
 * Turns the upload ledger into a browsable media library ("My Uploads" — the
 * images a user brings into the editor).
 *
 * `user_uploads` already records every confirmed upload with its key, slot, size
 * and content type, because storage quota needed exactly that. Listing it is
 * therefore most of the feature; what it lacks is the three things a GRID needs
 * rather than an accountant:
 *
 *   width/height      — the editor has to know an image's dimensions to place it,
 *                       and cannot ask S3. The server cannot read them either
 *                       without an image-decoding dependency, so the client sends
 *                       them at confirm; nullable because it may not, and because
 *                       every row written before this migration has none.
 *   original_filename — the stored key is a uuid, so "beach-sunset.jpg" is
 *                       otherwise lost and the grid has nothing to label a tile with.
 *
 * No new table, no second source of truth: the library IS the ledger, so a file
 * can never be listed but uncharged, or charged but invisible.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;

    await queryInterface.addColumn('user_uploads', 'width',  { type: S.INTEGER, allowNull: true });
    await queryInterface.addColumn('user_uploads', 'height', { type: S.INTEGER, allowNull: true });
    await queryInterface.addColumn('user_uploads', 'original_filename', { type: S.STRING(255), allowNull: true });

    // The library query is "my uploads in this slot, newest first".
    await queryInterface.addIndex('user_uploads', ['user_id', 'slot'], { name: 'idx_user_upload_user_slot' });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('user_uploads', 'idx_user_upload_user_slot');
    await queryInterface.removeColumn('user_uploads', 'original_filename');
    await queryInterface.removeColumn('user_uploads', 'height');
    await queryInterface.removeColumn('user_uploads', 'width');
  },
};
