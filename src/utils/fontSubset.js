const zlib = require('zlib');

/**
 * Name-only font subsetting — zero dependencies.
 *
 * The font picker draws every family's name in that family. Loading 2,000 full
 * font files to do that is not workable, so each font gets a tiny companion that
 * holds ONLY the glyphs of its own name (the idea behind Google Fonts' `menu`
 * files). This module produces that companion as WOFF2.
 *
 * Why hand-rolled: `npm install` is blocked in this environment (corporate SSL),
 * and the usual tool (subset-font → HarfBuzz WASM) is a dependency. A name-only
 * subset needs a small slice of the format, and Node ships Brotli, so WOFF2 output
 * needs nothing either.
 *
 * Scope — deliberately narrow, and every gap answers `null` rather than a guess:
 *   - TrueType outlines only (`glyf`): TTF, glyf-flavoured OTF, and WOFF wrapping
 *     either. CFF-flavoured OTF, WOFF2 input and .ttc collections are refused.
 *     Every library font carries a TTF anyway (Flutter renders nothing else).
 *   - Every non-space character of the name must be in the font. A half-covered
 *     name would render mixed with a fallback font, which is worse than the app
 *     font the picker falls back to on `null`.
 *   - Names in scripts that need shaping (Indic, Arabic, Thai, …) are refused:
 *     the subset drops GSUB/GPOS, so conjuncts and joining forms would come out
 *     wrong rather than merely unkerned.
 *   - Hinting is dropped (as pyftsubset --no-hinting): instructions are zeroed
 *     and fpgm/prep/cvt omitted. A preview row does not need it.
 *
 * The output is a valid font in its own right: glyphs are renumbered compactly,
 * composite glyphs have their component ids rewritten, and cmap, hmtx, loca, maxp,
 * hhea and head are rebuilt to match. post is cut to version 3 (no glyph names).
 */

class FontSubsetError extends Error {}
const fail = (msg) => { throw new FontSubsetError(msg); };

const tagAt = (buf, off) => buf.toString('latin1', off, off + 4);

// ---------------------------------------------------------------------------
// Reading: sfnt / WOFF → { flavor, tables: Map<tag, Buffer> }
// ---------------------------------------------------------------------------

function readSfnt(buf) {
  if (buf.length < 12) fail('truncated sfnt header');
  const numTables = buf.readUInt16BE(4);
  if (buf.length < 12 + numTables * 16) fail('truncated table directory');
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = tagAt(buf, rec);
    const off = buf.readUInt32BE(rec + 8);
    const len = buf.readUInt32BE(rec + 12);
    if (off + len > buf.length) fail(`table ${tag} out of bounds`);
    tables.set(tag, buf.subarray(off, off + len));
  }
  return tables;
}

function readWoff(buf) {
  if (buf.length < 44) fail('truncated WOFF header');
  const numTables = buf.readUInt16BE(12);
  if (buf.length < 44 + numTables * 20) fail('truncated WOFF directory');
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const rec      = 44 + i * 20;
    const tag      = tagAt(buf, rec);
    const off      = buf.readUInt32BE(rec + 4);
    const compLen  = buf.readUInt32BE(rec + 8);
    const origLen  = buf.readUInt32BE(rec + 12);
    if (off + compLen > buf.length) fail(`table ${tag} out of bounds`);
    const raw  = buf.subarray(off, off + compLen);
    const data = compLen < origLen ? zlib.inflateSync(raw) : raw;
    if (data.length !== origLen) fail(`table ${tag} has the wrong length`);
    tables.set(tag, data);
  }
  return tables;
}

// Returns the font's tables, or { reason } for a format this module will not
// handle. Reasons are stable strings — they surface in the admin backfill report.
function open(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return { reason: 'not_a_font' };
  const sig = tagAt(buf, 0);
  if (sig === 'wOF2') return { reason: 'woff2_input' };
  if (sig === 'ttcf') return { reason: 'collection' };
  if (sig === 'OTTO') return { reason: 'cff_unsupported' };
  if (sig === 'wOFF') {
    const flavor = buf.length >= 8 ? tagAt(buf, 4) : '';
    if (flavor === 'OTTO') return { reason: 'cff_unsupported' };
    return { tables: readWoff(buf) };
  }
  if (buf.readUInt32BE(0) === 0x00010000 || sig === 'true') return { tables: readSfnt(buf) };
  return { reason: 'not_a_font' };
}

// ---------------------------------------------------------------------------
// cmap lookup
// ---------------------------------------------------------------------------

function format4Lookup(t, base) {
  const segX2   = t.readUInt16BE(base + 6);
  const endsAt  = base + 14;
  const startsAt = endsAt + segX2 + 2;
  const deltaAt  = startsAt + segX2;
  const rangeAt  = deltaAt + segX2;
  if (rangeAt + segX2 > t.length) fail('cmap format 4 out of bounds');
  return (cp) => {
    if (cp > 0xffff) return 0;
    for (let i = 0; i < segX2; i += 2) {
      if (t.readUInt16BE(endsAt + i) < cp) continue;
      const start = t.readUInt16BE(startsAt + i);
      if (start > cp) return 0;
      const delta = t.readUInt16BE(deltaAt + i);
      const ro    = t.readUInt16BE(rangeAt + i);
      if (ro === 0) return (cp + delta) & 0xffff;
      const at = rangeAt + i + ro + 2 * (cp - start);
      if (at + 2 > t.length) return 0;
      const g = t.readUInt16BE(at);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
}

function format12Lookup(t, base) {
  const n = t.readUInt32BE(base + 12);
  if (base + 16 + n * 12 > t.length) fail('cmap format 12 out of bounds');
  return (cp) => {
    for (let i = 0; i < n; i++) {
      const g = base + 16 + i * 12;
      const start = t.readUInt32BE(g);
      const end   = t.readUInt32BE(g + 4);
      if (cp >= start && cp <= end) return t.readUInt32BE(g + 8) + (cp - start);
    }
    return 0;
  };
}

// Unicode subtables only, best first. A symbol-encoded (3,0) font maps its glyphs
// into the private-use area, so it genuinely cannot draw its name in text.
const CMAP_PREFERENCE = [[3, 10], [0, 6], [0, 4], [3, 1], [0, 3], [0, 2], [0, 1], [0, 0]];

function cmapLookup(t) {
  if (!t) fail('no cmap table');
  const n = t.readUInt16BE(2);
  const subtables = [];
  for (let i = 0; i < n; i++) {
    const rec = 4 + i * 8;
    subtables.push({ platform: t.readUInt16BE(rec), encoding: t.readUInt16BE(rec + 2), offset: t.readUInt32BE(rec + 4) });
  }
  for (const [p, e] of CMAP_PREFERENCE) {
    const st = subtables.find((s) => s.platform === p && s.encoding === e);
    if (!st || st.offset + 2 > t.length) continue;
    const format = t.readUInt16BE(st.offset);
    if (format === 12) return format12Lookup(t, st.offset);
    if (format === 4) return format4Lookup(t, st.offset);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

const ARG_1_AND_2_ARE_WORDS    = 0x0001;
const WE_HAVE_A_SCALE          = 0x0008;
const MORE_COMPONENTS          = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO     = 0x0080;
const WE_HAVE_INSTRUCTIONS     = 0x0100;

function readLoca(tables, numGlyphs) {
  const loca = tables.get('loca');
  const long = tables.get('head').readInt16BE(50) === 1;
  const need = (numGlyphs + 1) * (long ? 4 : 2);
  if (!loca || loca.length < need) fail('loca too short');
  const offsets = new Array(numGlyphs + 1);
  for (let i = 0; i <= numGlyphs; i++) {
    offsets[i] = long ? loca.readUInt32BE(i * 4) : loca.readUInt16BE(i * 2) * 2;
  }
  return offsets;
}

// Walks a composite glyph's component records, calling visit(gidOffset) with the
// byte offset of each component's glyph index. Returns the offset just past the
// last record and whether instructions follow.
function walkComponents(g, visit) {
  let p = 10;
  let flags;
  let hasInstructions = false;
  do {
    if (p + 4 > g.length) fail('composite glyph truncated');
    flags = g.readUInt16BE(p);
    visit(p + 2);
    p += 4;
    p += (flags & ARG_1_AND_2_ARE_WORDS) ? 4 : 2;
    if (flags & WE_HAVE_A_SCALE) p += 2;
    else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) p += 4;
    else if (flags & WE_HAVE_A_TWO_BY_TWO) p += 8;
    if (flags & WE_HAVE_INSTRUCTIONS) hasInstructions = true;
  } while (flags & MORE_COMPONENTS);
  if (p > g.length) fail('composite glyph truncated');
  return { end: p, hasInstructions };
}

// Returns a copy of the glyph with hinting removed and (for composites) component
// ids remapped through `remap`.
function rewriteGlyph(g, remap) {
  if (g.length === 0) return g;
  const contours = g.readInt16BE(0);

  if (contours < 0) {
    const copy = Buffer.from(g);
    const { end } = walkComponents(copy, (at) => {
      copy.writeUInt16BE(remap(copy.readUInt16BE(at)), at);
      copy.writeUInt16BE(copy.readUInt16BE(at - 2) & ~WE_HAVE_INSTRUCTIONS, at - 2);
    });
    return copy.subarray(0, end);
  }

  const instrLenAt = 10 + contours * 2;
  if (instrLenAt + 2 > g.length) fail('simple glyph truncated');
  const instrLen = g.readUInt16BE(instrLenAt);
  const restAt   = instrLenAt + 2 + instrLen;
  if (restAt > g.length) fail('simple glyph truncated');
  const out = Buffer.alloc(g.length - instrLen);
  g.copy(out, 0, 0, instrLenAt);
  out.writeUInt16BE(0, instrLenAt);
  g.copy(out, instrLenAt + 2, restAt);
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const pad4 = (n) => (n + 3) & ~3;

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; }

// cmap with a (3,1) format 4 subtable — one segment per code point, which for a
// handful of characters is smaller than computing ranges — plus a (3,10) format 12
// subtable when anything sits outside the BMP.
function buildCmap(mapping /* [[cp, gid]] sorted by cp */) {
  const bmp = mapping.filter(([cp]) => cp <= 0xffff);
  const segs = [...bmp, [0xffff, null]];
  const segCount = segs.length;
  const pow = 2 ** Math.floor(Math.log2(segCount));
  const f4 = Buffer.concat([
    u16(4), u16(16 + segCount * 8), u16(0), u16(segCount * 2),
    u16(pow * 2), u16(Math.log2(pow)), u16(segCount * 2 - pow * 2),
    ...segs.map(([cp]) => u16(cp)),
    u16(0),
    ...segs.map(([cp]) => u16(cp)),
    ...segs.map(([cp, gid]) => u16(gid === null ? 1 : (gid - cp))),
    ...segs.map(() => u16(0)),
  ]);

  const astral = mapping.filter(([cp]) => cp > 0xffff);
  const subtables = [[3, 1, f4]];
  if (astral.length) {
    const groups = mapping.map(([cp, gid]) => Buffer.concat([u32(cp), u32(cp), u32(gid)]));
    subtables.push([3, 10, Buffer.concat([u16(12), u16(0), u32(16 + groups.length * 12), u32(0), u32(groups.length), ...groups])]);
  }

  let offset = 4 + subtables.length * 8;
  const records = [];
  for (const [p, e, data] of subtables) {
    records.push(Buffer.concat([u16(p), u16(e), u32(offset)]));
    offset += data.length;
  }
  return Buffer.concat([u16(0), u16(subtables.length), ...records, ...subtables.map((s) => s[2])]);
}

function checksum(buf) {
  let sum = 0;
  const padded = buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

// Plain TrueType file from a tag → bytes map. Also fixes head.checkSumAdjustment,
// so the same head bytes are valid inside the WOFF2 built from these tables.
function buildSfnt(tables) {
  const tags = [...tables.keys()].sort();
  const n    = tags.length;
  const pow  = 2 ** Math.floor(Math.log2(n));
  const header = Buffer.concat([u32(0x00010000), u16(n), u16(pow * 16), u16(Math.log2(pow)), u16(n * 16 - pow * 16)]);

  const head = tables.get('head');
  head.writeUInt32BE(0, 8);

  let offset = 12 + n * 16;
  const dir = [];
  const body = [];
  for (const tag of tags) {
    const data = tables.get(tag);
    dir.push(Buffer.concat([Buffer.from(tag, 'latin1'), u32(checksum(data)), u32(offset), u32(data.length)]));
    body.push(data, Buffer.alloc(pad4(data.length) - data.length));
    offset += pad4(data.length);
  }
  const font = Buffer.concat([header, ...dir, ...body]);
  const adj  = (0xb1b0afba - checksum(font)) >>> 0;
  head.writeUInt32BE(adj, 8);
  const headAt = dir[tags.indexOf('head')].readUInt32BE(8);
  font.writeUInt32BE(adj, headAt + 8);
  return font;
}

// WOFF2 known-table indices (spec §5.1); only the ones a subset can contain.
const WOFF2_TAG_INDEX = {
  cmap: 0, head: 1, hhea: 2, hmtx: 3, maxp: 4, name: 5, 'OS/2': 6, post: 7, glyf: 10, loca: 11,
};

function base128(n) {
  const bytes = [n & 0x7f];
  for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) bytes.unshift((n & 0x7f) | 0x80);
  return Buffer.from(bytes);
}

// WOFF2 with no table transforms: glyf/loca carry transform version 3 (the null
// transform for those two), everything else version 0 (which is null for them).
// The table data is concatenated and Brotli-compressed as one stream.
function buildWoff2(tables) {
  const tags = [...tables.keys()].sort();
  const sfntSize = 12 + tags.length * 16 + tags.reduce((s, t) => s + pad4(tables.get(t).length), 0);

  const dir = [];
  for (const tag of tags) {
    const idx  = WOFF2_TAG_INDEX[tag];
    const xf   = (tag === 'glyf' || tag === 'loca') ? 3 : 0;
    const flag = ((xf << 6) | (idx === undefined ? 63 : idx)) & 0xff;
    dir.push(Buffer.from([flag]));
    if (idx === undefined) dir.push(Buffer.from(tag, 'latin1'));
    dir.push(base128(tables.get(tag).length));
  }
  const directory  = Buffer.concat(dir);
  const compressed = zlib.brotliCompressSync(Buffer.concat(tags.map((t) => tables.get(t))), {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]:    zlib.constants.BROTLI_MODE_FONT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    },
  });

  const unpadded = 48 + directory.length + compressed.length;
  const length   = pad4(unpadded);
  const header = Buffer.concat([
    Buffer.from('wOF2', 'latin1'), u32(0x00010000), u32(length), u16(tags.length), u16(0),
    u32(sfntSize), u32(compressed.length), u16(1), u16(0),
    u32(0), u32(0), u32(0), u32(0), u32(0),
  ]);
  return Buffer.concat([header, directory, compressed, Buffer.alloc(length - unpadded)]);
}

// ---------------------------------------------------------------------------
// Subsetting
// ---------------------------------------------------------------------------

// Scripts whose correct rendering depends on shaping (GSUB/GPOS), which this
// subset does not carry. Latin, Greek, Cyrillic, CJK and symbols draw correctly
// from cmap alone.
const NEEDS_SHAPING = [
  [0x0590, 0x08ff], // Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic
  [0x0900, 0x0dff], // Devanagari … Sinhala
  [0x0e00, 0x0fff], // Thai, Lao, Tibetan
  [0x1000, 0x109f], // Myanmar
  [0x1780, 0x17ff], // Khmer
  [0x1800, 0x18af], // Mongolian
  [0xa8e0, 0xa8ff], // Devanagari Extended
  [0xfb1d, 0xfdff], // Hebrew / Arabic presentation forms
  [0xfe70, 0xfeff], // Arabic presentation forms B
];
const needsShaping = (cp) => NEEDS_SHAPING.some(([lo, hi]) => cp >= lo && cp <= hi);

/**
 * Subset a font to the characters of `text` and return it as WOFF2 (or, with
 * `{ format: 'ttf' }`, as a plain TrueType file — handy for checking by hand).
 *
 * @returns {{ bytes: Buffer|null, reason?: string, glyphs?: number }}
 *   `bytes` null with a `reason` when no faithful preview can be made:
 *   not_a_font | woff2_input | collection | cff_unsupported | no_truetype_outlines |
 *   no_unicode_cmap | empty_text | needs_shaping | name_not_covered.
 * @throws {FontSubsetError} when the file is a supported format but malformed.
 */
function subset(input, text, { format = 'woff2' } = {}) {
  const opened = open(input);
  if (opened.reason) return { bytes: null, reason: opened.reason };
  const { tables } = opened;

  for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'cmap']) {
    if (!tables.has(t)) fail(`missing ${t} table`);
  }
  if (!tables.has('glyf') || !tables.has('loca')) return { bytes: null, reason: 'no_truetype_outlines' };

  const codepoints = [...new Set([...String(text || '')].map((c) => c.codePointAt(0)))];
  const visible    = codepoints.filter((cp) => !/\s/u.test(String.fromCodePoint(cp)));
  if (!visible.length) return { bytes: null, reason: 'empty_text' };
  if (visible.some(needsShaping)) return { bytes: null, reason: 'needs_shaping' };

  const lookup = cmapLookup(tables.get('cmap'));
  if (!lookup) return { bytes: null, reason: 'no_unicode_cmap' };

  const head = tables.get('head');
  const hhea = tables.get('hhea');
  const maxp = tables.get('maxp');
  const hmtx = tables.get('hmtx');
  const glyf = tables.get('glyf');
  const numGlyphs = maxp.readUInt16BE(4);
  const numHMetrics = hhea.readUInt16BE(34);
  if (numHMetrics === 0 || numHMetrics > numGlyphs) fail('bad numberOfHMetrics');
  if (hmtx.length < numHMetrics * 4 + (numGlyphs - numHMetrics) * 2) fail('hmtx too short');

  // Every visible character must map; whitespace is kept when the font has it.
  const mapping = [];
  for (const cp of codepoints) {
    const gid = lookup(cp);
    const usable = gid > 0 && gid < numGlyphs;
    if (!usable && visible.includes(cp)) return { bytes: null, reason: 'name_not_covered' };
    if (usable) mapping.push([cp, gid]);
  }

  const offsets = readLoca(tables, numGlyphs);
  const glyphAt = (gid) => {
    const start = offsets[gid];
    const end   = offsets[gid + 1];
    if (end < start || end > glyf.length) fail(`glyph ${gid} out of bounds`);
    return glyf.subarray(start, end);
  };

  // .notdef + the mapped glyphs, closed over composite components.
  const keep  = new Set([0]);
  const queue = mapping.map(([, gid]) => gid);
  while (queue.length) {
    const gid = queue.pop();
    if (keep.has(gid)) continue;
    if (gid >= numGlyphs) fail(`component glyph ${gid} out of range`);
    keep.add(gid);
    const g = glyphAt(gid);
    if (g.length >= 10 && g.readInt16BE(0) < 0) walkComponents(g, (at) => queue.push(g.readUInt16BE(at)));
  }

  const oldIds = [...keep].sort((a, b) => a - b);
  const newId  = new Map(oldIds.map((old, i) => [old, i]));
  const remap  = (old) => {
    if (!newId.has(old)) fail(`unmapped component ${old}`);
    return newId.get(old);
  };

  // glyf + loca (long offsets: simplest, and the table is tiny either way)
  const glyphs = [];
  const loca   = Buffer.alloc((oldIds.length + 1) * 4);
  let at = 0;
  oldIds.forEach((old, i) => {
    loca.writeUInt32BE(at, i * 4);
    const g = rewriteGlyph(glyphAt(old), remap);
    const padded = Buffer.alloc(pad4(g.length));
    g.copy(padded);
    glyphs.push(padded);
    at += padded.length;
  });
  loca.writeUInt32BE(at, oldIds.length * 4);

  // hmtx: every glyph gets a full metric — no trailing-lsb compression needed.
  const newHmtx = Buffer.alloc(oldIds.length * 4);
  oldIds.forEach((old, i) => {
    const adv = hmtx.readUInt16BE((old < numHMetrics ? old : numHMetrics - 1) * 4);
    const lsb = old < numHMetrics
      ? hmtx.readInt16BE(old * 4 + 2)
      : hmtx.readInt16BE(numHMetrics * 4 + (old - numHMetrics) * 2);
    newHmtx.writeUInt16BE(adv, i * 4);
    newHmtx.writeInt16BE(lsb, i * 4 + 2);
  });

  const newHead = Buffer.from(head);
  newHead.writeInt16BE(1, 50);                       // indexToLocFormat: long

  const newHhea = Buffer.from(hhea);
  newHhea.writeUInt16BE(oldIds.length, 34);

  const newMaxp = Buffer.from(maxp);
  newMaxp.writeUInt16BE(oldIds.length, 4);

  const newPost = Buffer.alloc(32);
  const post = tables.get('post');
  if (post && post.length >= 32) post.copy(newPost, 0, 0, 32);
  newPost.writeUInt32BE(0x00030000, 0);

  const out = new Map([
    ['head', newHead], ['hhea', newHhea], ['maxp', newMaxp], ['hmtx', newHmtx],
    ['loca', loca], ['glyf', Buffer.concat(glyphs)], ['post', newPost],
    ['cmap', buildCmap(mapping.map(([cp, gid]) => [cp, newId.get(gid)]).sort((a, b) => a[0] - b[0]))],
  ]);
  if (tables.has('OS/2')) out.set('OS/2', Buffer.from(tables.get('OS/2')));
  if (tables.has('name')) out.set('name', Buffer.from(tables.get('name')));

  // Building the sfnt fixes head.checkSumAdjustment for both outputs.
  const ttf = buildSfnt(out);
  return { bytes: format === 'ttf' ? ttf : buildWoff2(out), glyphs: oldIds.length };
}

module.exports = { subset, open, FontSubsetError, buildSfnt, buildWoff2, buildCmap };
