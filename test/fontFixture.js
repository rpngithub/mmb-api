const zlib = require('zlib');
const { buildSfnt, buildCmap } = require('../src/utils/fontSubset');

/**
 * A tiny but structurally real TrueType font, built in memory so the suite needs
 * no font file on disk (and nothing licensed in the repo).
 *
 *   gid 0  .notdef   empty
 *   gid 1  'A'       simple glyph, WITH hinting instructions
 *   gid 2  'B'       simple glyph
 *   gid 3  'C'       COMPOSITE of 1 + 2, with instructions
 *   gid 4  'D'       simple glyph (never part of a test name, so it must be dropped)
 *   gid 5  ' '       empty
 *
 * `extraChars` maps further characters onto glyph 1, so a test can make a family
 * name like "TST Preview 123" fully covered. numberOfHMetrics is 3, so glyphs 3-5
 * exercise the trailing-lsb part of hmtx.
 */

const i16 = (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };

function simpleGlyph(size) {
  return Buffer.concat([
    i16(1), i16(0), i16(0), i16(size), i16(size),  // 1 contour + bbox
    u16(2),                                         // endPtsOfContours
    u16(2), Buffer.from([0xb0, 0x00]),              // 2 bytes of instructions
    Buffer.from([0x01, 0x01, 0x01]),                // flags: on-curve, int16 deltas
    i16(0), i16(size), i16(-size),                  // x
    i16(0), i16(size), i16(0),                      // y
  ]);
}

function compositeGlyph(a, b) {
  return Buffer.concat([
    i16(-1), i16(0), i16(0), i16(700), i16(700),
    u16(0x0001 | 0x0020), u16(a), i16(0), i16(0),           // words, MORE_COMPONENTS
    u16(0x0001 | 0x0100), u16(b), i16(300), i16(0),         // words, WE_HAVE_INSTRUCTIONS
    u16(3), Buffer.from([0xb0, 0x01, 0x00]),
  ]);
}

const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);

function buildTestFont({ extraChars = '' } = {}) {
  const glyphs = [Buffer.alloc(0), simpleGlyph(500), simpleGlyph(600), compositeGlyph(1, 2), simpleGlyph(400), Buffer.alloc(0)];

  const loca = [];
  let at = 0;
  const glyf = glyphs.map((g) => { loca.push(at); const p = pad4(g); at += p.length; return p; });
  loca.push(at);

  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x5f0f3cf5, 12);   // magic
  head.writeUInt16BE(1000, 18);          // unitsPerEm
  head.writeInt16BE(1, 50);              // long loca

  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeUInt16BE(3, 34);             // numberOfHMetrics

  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(glyphs.length, 4);

  const hmtx = Buffer.concat([
    u16(500), i16(0), u16(510), i16(1), u16(620), i16(2),  // full metrics 0-2
    i16(3), i16(4), i16(5),                                 // lsb only 3-5
  ]);

  const map = new Map([[0x41, 1], [0x42, 2], [0x43, 3], [0x44, 4], [0x20, 5]]);
  for (const ch of extraChars) {
    const cp = ch.codePointAt(0);
    if (!map.has(cp)) map.set(cp, 1);
  }

  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00020000, 0);

  return buildSfnt(new Map([
    ['head', head], ['hhea', hhea], ['maxp', maxp], ['hmtx', hmtx],
    ['loca', Buffer.concat(loca.map(u32))], ['glyf', Buffer.concat(glyf)], ['post', post],
    ['cmap', buildCmap([...map].sort((a, b) => a[0] - b[0]))],
  ]));
}

// Re-wrap a TrueType file as WOFF 1.0 (zlib per table), for the WOFF input path.
function toWoff(ttf) {
  const n = ttf.readUInt16BE(4);
  const entries = [];
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    const data = ttf.subarray(ttf.readUInt32BE(rec + 8), ttf.readUInt32BE(rec + 8) + ttf.readUInt32BE(rec + 12));
    const comp = zlib.deflateSync(data);
    entries.push({ tag: ttf.subarray(rec, rec + 4), checksum: ttf.readUInt32BE(rec + 4), data, comp: comp.length < data.length ? comp : data });
  }
  let offset = 44 + n * 20;
  const dir = [];
  const body = [];
  for (const e of entries) {
    dir.push(Buffer.concat([e.tag, u32(offset), u32(e.comp.length), u32(e.data.length), u32(e.checksum)]));
    const p = pad4(e.comp);
    body.push(p);
    offset += p.length;
  }
  const header = Buffer.concat([
    Buffer.from('wOFF', 'latin1'), u32(0x00010000), u32(offset), u16(n), u16(0),
    u32(ttf.length), u16(1), u16(0), u32(0), u32(0), u32(0), u32(0), u32(0),
  ]);
  return Buffer.concat([header, ...dir, ...body]);
}

module.exports = { buildTestFont, toWoff };
