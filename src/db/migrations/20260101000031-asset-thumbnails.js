'use strict';

/**
 * assets.thumbnail_s3_key — a preview that can be shown to someone who is not
 * allowed to have the file.
 *
 * The public asset list withholds `s3_key` for a premium asset a guest/free
 * viewer cannot use (asset.service#listAssets). That protects the file, but it
 * also leaves the editor with nothing to draw: a locked asset rendered as a grey
 * box sells nothing. Every other catalogue entity already solves this by keeping
 * the browse image apart from the deliverable — templates and frames both carry
 * `thumbnail_s3_key` next to their payload — and this brings assets in line.
 *
 * The thumbnail is a SEPARATE, deliberately degraded object (small, watermarked,
 * flattened) uploaded to `assets/thumbnail/`, never a second pointer at the
 * original: it is served to viewers who have not paid, so anything usable stored
 * here would hand over exactly what `s3_key` is being withheld to protect. It is
 * always returned — locked or not — which is the whole point of the column.
 *
 * Nullable, with no backfill possible: an existing asset has no reduced copy to
 * point at, and the API cannot invent one. Until an admin uploads thumbnails,
 * locked rows carry `thumbnail_s3_key: null` and behave exactly as they do today.
 * A row that is NOT premium is unaffected either way — its `s3_key` is served,
 * and clients fall back to it.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Matches assets.s3_key (and frames/templates' own thumbnail_s3_key) — same
    // kind of value, so the same width.
    await queryInterface.addColumn('assets', 'thumbnail_s3_key', {
      type: Sequelize.STRING(500), allowNull: true, after: 's3_key',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('assets', 'thumbnail_s3_key');
  },
};
