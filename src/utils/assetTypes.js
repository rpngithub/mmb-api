// The kinds of file the editor's ASSET LIBRARY holds — things a user drags onto a
// canvas. Single source of truth: this list was previously copy-pasted into
// asset.service, upload.service and asset.validator, which is precisely how three
// copies of one list drift apart.
//
// 'font' is deliberately ABSENT, though the `assets.asset_type` DB enum still
// carries it. A font is not one file: a family is several (regular, bold, italic;
// woff2 for the web, ttf/otf for the Flutter app) and it needs script coverage to
// know whether it can draw Tamil. The flat assets table can express none of that,
// so fonts live in `fonts` + `font_files` instead — see font.service.
//
// Leaving the value in the DB enum is harmless and avoids a migration; dropping it
// here is what stops a new font being filed somewhere the Brand Kit can never see
// it. There were zero font assets when this was removed.
const ASSET_TYPES = ['icon', 'emoji', 'shape', 'audio', 'video', 'animated', 'bg'];

module.exports = { ASSET_TYPES };
