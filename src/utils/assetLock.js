// What a locked asset row keeps. `s3_key` is the deliverable and goes;
// `thumbnail_s3_key` is the browse image and STAYS — the lock is meant to stop the
// file being used, not to stop the asset being seen. A locked card with nothing to
// draw is the reason that column exists, so withholding it here would defeat it.
//
// This only holds because the thumbnail is a degraded copy by construction (see
// migration 031 and upload.service's `asset_thumbnail` slot). Store the original's
// key in that column and the delete below stops protecting anything.
//
// Shared by every list that serves assets (the browse and My Favourites), so the
// rule cannot drift between them.
const lockAsset = (a) => { delete a.s3_key; return a; };

module.exports = { lockAsset };
