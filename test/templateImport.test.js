// Bulk template import (src/services/templateImport.service.js): manifest dry run,
// file checks, start, per-row presign/complete with resume, finalize's publish
// decisions, cancel, and permissions.
//
// S3 is replaced by an in-memory bucket for the whole file: a "PUT" is the test
// writing a key into `bucket`. Every catalog row is created here with random
// names (the test DB persists between runs) and removed afterwards.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const h = require('./helpers');
const s3 = require('../src/utils/s3Helper');
const { extractReferences } = require('../src/services/templateImport.service');

const { models } = h;
const {
  TemplateFamily, Template, Tag, TemplateCategory, BusinessCategory, Language, TemplateSize,
  TemplateImportBatch,
} = models;
const P = '/api/v1/admin/template-imports';

const ADMIN   = h.adminToken(['*']);
const READER  = h.adminToken(['templates.read']);
const rnd = () => crypto.randomBytes(4).toString('hex');
const tag = rnd();

// ---- In-memory S3 ----
const bucket = new Map();         // key -> { size, status }
const original = {};
const S3_FNS = ['listObjects', 'getPresignedPutUrl', 'putObjectTagging', 'readObjectStart', 'deleteByPrefix'];

const track = { families: [], tags: [], batches: [], categories: [], industries: [], sizes: [], languages: [] };
let category, industry, size, size2, english, other;

const req = (method, path, body, token = ADMIN) => h.request(method, `${P}${path}`, { token, body });

// One row's upload as the admin panel does it: presign, PUT what was asked for.
async function upload(uid, row, { skip = [] } = {}) {
  const r = await req('POST', `/${uid}/items/${row}/presign`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  for (const f of r.body.data.files) {
    if (skip.includes(f.name)) continue;
    bucket.set(f.key, { size: f.size, status: 'pending' });
  }
  return r.body.data;
}

const csv = (rows) => [
  'family_name,category,industries,tags,is_premium,template_type,search_keywords,language,size,folder,thumbnail',
  ...rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')),
].join('\n');

const design = (...files) => JSON.stringify({ layers: files.map((f, i) => ({ id: i, src: f })), font: 'Poppins-Regular.ttf', text: 'Visit shop.com' });

before(async () => {
  await models.sequelize.authenticate();
  await h.start();
  for (const fn of S3_FNS) original[fn] = s3[fn];
  s3.listObjects = async (prefix) => [...bucket.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.size }));
  s3.getPresignedPutUrl = async (key) => `https://s3.test/${key}?signed`;
  s3.putObjectTagging = async (key, status) => { if (bucket.has(key)) bucket.get(key).status = status; };
  s3.readObjectStart = async () => null;
  s3.deleteByPrefix = async (prefix) => { for (const k of [...bucket.keys()]) if (k.startsWith(prefix)) bucket.delete(k); };

  english = await Language.findOne({ where: { code: 'en' } });
  assert.ok(english, 'test DB needs the en language');
  other = await Language.create({ code: `q${tag.slice(0, 5)}`, name: `Lang ${tag}`, native_name: `Lang ${tag}` });
  track.languages.push(other.id);
  category = await TemplateCategory.create({ name: `TI Cat ${tag}`, slug: `ti-cat-${tag}` });
  track.categories.push(category.id);
  industry = await BusinessCategory.create({ name: `TI Ind ${tag}`, slug: `ti-ind-${tag}` });
  track.industries.push(industry.id);
  size = await TemplateSize.create({ name: `TI Square ${tag}`, slug: `ti-sq-${tag}`, width: 1080, height: 1080 });
  size2 = await TemplateSize.create({ name: `TI Story ${tag}`, slug: `ti-st-${tag}`, width: 1080, height: 1920 });
  track.sizes.push(size.id, size2.id);
});

after(async () => {
  for (const fn of S3_FNS) s3[fn] = original[fn];
  const fams = await TemplateFamily.findAll({ where: { name: { [require('sequelize').Op.like]: `%${tag}%` } } });
  for (const f of fams) {
    await Template.destroy({ where: { family_id: f.id } });
    await f.setTags([]);
    await f.setBusinessCategories([]);
    await f.destroy();
  }
  await Tag.destroy({ where: { name: { [require('sequelize').Op.like]: `%${tag}%` } } });
  await TemplateImportBatch.destroy({ where: { label: { [require('sequelize').Op.like]: `%${tag}%` } } });
  await TemplateSize.destroy({ where: { id: track.sizes } });
  await TemplateCategory.destroy({ where: { id: track.categories } });
  await BusinessCategory.destroy({ where: { id: track.industries } });
  await Language.destroy({ where: { id: track.languages } });
  await h.stop();
  await models.sequelize.close();
});

test('extractReferences: bare media names only, fonts apart, text ignored', () => {
  const refs = extractReferences({
    a: 'bg.png', b: ['logo.svg', { c: 'clip.mp4' }], d: 'Poppins.ttf', e: 'assets/x.png', f: 'shop.com', g: 'my bg.jpg',
  });
  assert.deepStrictEqual(refs.files.sort(), ['bg.png', 'clip.mp4', 'logo.svg', 'my bg.jpg']);
  assert.deepStrictEqual(refs.fonts, ['Poppins.ttf']);
  assert.deepStrictEqual(refs.paths, ['assets/x.png']);
  const web = extractReferences(['https://cdn.test/a.png?v=1', '//cdn.test/dir/b%20c.png', 'data:image/a.png', 'blob:x.png', 'https://cdn.test/']);
  assert.deepStrictEqual(web.files, []);
  assert.deepStrictEqual(web.urls.map((u) => u.name), ['a.png', 'b c.png']);
  // "./" and backslashes are normalized; display keys are labels, not references.
  const norm = extractReferences({ src: './bg.png', other: '.\\logo.svg', data: { name: 'pattern.png', originalName: 'x.jpg' } });
  assert.deepStrictEqual(norm.files.sort(), ['bg.png', 'logo.svg']);
  assert.deepStrictEqual(norm.labels.sort(), ['pattern.png', 'x.jpg']);
});

// The editor's export, as in the real "Food Bonanza" bundle: images load by S3 URL
// (src, data.sourceUrl, assets[].sourceUrl) whose last segment is a UUID file name;
// the original upload name survives only as data.name.
const S3_HOST = 'https://temp-assets.s3.ap-south-1.amazonaws.com';
const UUIDS = ['07e0dc23-9399-47d0-bde0-9f72c2022294', 'c90047dc-afaa-4752-988d-69723c2996e5', 'c1c42e53-d5f1-4c86-b015-8b5597ab2171'];
const editorExport = () => JSON.stringify({
  version: 1,
  metadata: { id: 'da9e2099-a722-447f-b5ce-1e16f8a51330', name: 'Food Bonanza' },
  pages: [{ fabric: { objects: [
    { type: 'image', src: `${S3_HOST}/${UUIDS[0]}.png`, data: { id: '390d8f4e-64fb-4154-9141-63d00c2f2d59', sourceUrl: `${S3_HOST}/${UUIDS[0]}.png` } },
    { type: 'image', src: `${S3_HOST}/${UUIDS[1]}.png`, data: { id: '6287b4b3-9ff7-495a-bd0e-6348b7b8cf4f', name: 'pattern.png', sourceUrl: `${S3_HOST}/${UUIDS[1]}.png` } },
    { type: 'textbox', text: 'Food Bonanza', data: { id: '3539f4c5-8a8d-44e3-8614-c0cd12429cb4' } },
    { type: 'image', src: `${S3_HOST}/${UUIDS[2]}.png`, data: { id: 'ee7015fd-752e-4373-a4b4-ca1ef8cc0e08', name: 'food.png', sourceUrl: `${S3_HOST}/${UUIDS[2]}.png` } },
  ] } }],
  assets: UUIDS.map((u, i) => ({ id: `0000000${i}-0000-0000-0000-000000000000`, sourceUrl: `${S3_HOST}/${u}.png` })),
  fonts: [],
});

test('extractReferences: editor export — UUID files by URL, original names are labels', () => {
  const refs = extractReferences(JSON.parse(editorExport()));
  assert.deepStrictEqual(refs.files, [], 'pattern.png / food.png are display names, not references');
  assert.deepStrictEqual(refs.labels.sort(), ['food.png', 'pattern.png']);
  assert.deepStrictEqual(refs.urls.map((u) => u.name).sort(), UUIDS.map((u) => `${u}.png`).sort());
});

test('manifest template downloads as CSV with every column', async () => {
  const r = await h.request('GET', `${P}/manifest-template?example=1`, { token: READER });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.match(String(r.body), /family_name,category,industries,tags/);
});

test('a reader cannot create an import', async () => {
  const r = await req('POST', '', { manifest: csv([[`X ${tag}`, '', '', '', '', '', '', '', size.slug, 'x', '']]) }, READER);
  assert.strictEqual(r.status, 403);
});

test('full flow: dry run, start, upload, complete, finalize', async () => {
  const famA = `TI Alpha ${tag}`;
  const famB = `TI Beta ${tag}`;
  const newTag = `ti-new-${tag}`;
  const manifest = csv([
    [famA, category.slug, industry.slug, `${newTag}|ti-two-${tag}`, '0', 'image', 'diya|lamp', 'en', size.slug, 'alpha/en', ''],
    [famA, '', '', '', '', '', '', other.code, size.slug, 'alpha/other', 'cover.jpg'],
    [famB, '', '', '', '', '', '', '', size2.slug, 'beta/free', ''],
  ]);

  // ① manifest
  let r = await req('POST', '', { label: `run ${tag}`, manifest });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const uid = r.body.data.uid;
  assert.strictEqual(r.body.data.status, 'draft');
  assert.deepStrictEqual(r.body.data.items.map((i) => i.stage), ['awaiting_files', 'awaiting_files', 'awaiting_files']);
  assert.ok(r.body.data.items[0].warnings.some((w) => w.level === 'info' && w.message.includes(newTag)), 'unknown tag reported as info');
  const beta = r.body.data.designs.find((d) => d.family_name === famB);
  assert.ok(beta.warnings.some((w) => w.field === 'tag_ids'), 'beta predicted draft: no tags');
  assert.ok(beta.warnings.some((w) => w.field === 'category_id'), 'beta predicted draft: no anchor');
  assert.ok(!(await Tag.findOne({ where: { name: newTag } })), 'dry run creates no tag');

  // ② files
  r = await req('POST', `/${uid}/files`, { items: [
    { row: 1, content: design('bg.png', 'logo.svg'), files: [
      { name: 'design.json', size: 100 }, { name: 'thumbnail.png', size: 2000 }, { name: 'bg.png', size: 5000 },
      { name: 'logo.svg', size: 300 }, { name: 'notes.txt', size: 10 },
    ] },
    { row: 2, content: design('bg.png'), files: [{ name: 'cover.jpg', size: 1500 }, { name: 'bg.png', size: 5000 }] },
    { row: 3, content: design('pattern.webp'), files: [{ name: 'thumbnail.png', size: 900 }, { name: 'pattern.webp', size: 800 }] },
  ] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.data.status, 'validated');
  const row1 = r.body.data.items[0];
  assert.strictEqual(row1.stage, 'valid', JSON.stringify(row1.errors));
  assert.deepStrictEqual(row1.files.map((f) => f.name).sort(), ['bg.png', 'logo.svg', 'thumbnail.png']);
  assert.ok(row1.warnings.some((w) => w.message.includes('notes.txt')), 'unused file is a warning');

  // ③ start
  r = await req('POST', `/${uid}/start`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.data.status, 'running');
  assert.ok(r.body.data.items.every((i) => i.stage === 'created' && i.template_uid));
  const alpha = await TemplateFamily.findOne({ where: { name: famA } });
  assert.strictEqual(alpha.status, 'draft');
  assert.strictEqual(alpha.category_id, category.id);
  assert.strictEqual(await alpha.countTags(), 2);
  assert.ok(await Tag.findOne({ where: { name: newTag } }), 'start creates the unknown tag');

  // start again: nothing new
  r = await req('POST', `/${uid}/start`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await Template.count({ where: { family_id: alpha.id } }), 2);

  // ④ + ⑤ row 1, interrupted: one file never lands
  const p1 = await upload(uid, 1, { skip: ['logo.svg'] });
  assert.strictEqual(p1.files.length, 3);
  r = await req('POST', `/${uid}/items/1/complete`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.stage, 'failed');
  assert.strictEqual(r.body.data.failed_stage, 'upload');
  assert.ok(r.body.data.errors.some((e) => e.message.includes('logo.svg')));

  // resume: only the missing file is signed again
  const p1b = await upload(uid, 1);
  assert.deepStrictEqual(p1b.files.map((f) => f.name), ['logo.svg']);
  assert.deepStrictEqual(p1b.already_uploaded.sort(), ['bg.png', 'thumbnail.png']);
  r = await req('POST', `/${uid}/items/1/complete`);
  assert.strictEqual(r.body.data.stage, 'completed', JSON.stringify(r.body));
  assert.strictEqual(r.body.data.result, 'published');
  const v1 = await Template.findOne({ where: { uid: r.body.data.template_uid } });
  assert.strictEqual(v1.status, 'active');
  assert.strictEqual(v1.thumbnail_s3_key, `templates/${v1.uid}/thumbnail.png`);
  assert.ok(v1.content.includes('bg.png'));
  assert.strictEqual(bucket.get(`templates/${v1.uid}/bg.png`).status, 'active');

  // complete again: same answer
  r = await req('POST', `/${uid}/items/1/complete`);
  assert.strictEqual(r.body.data.result, 'published');

  for (const row of [2, 3]) {
    await upload(uid, row);
    r = await req('POST', `/${uid}/items/${row}/complete`);
    assert.strictEqual(r.body.data.result, 'published', JSON.stringify(r.body));
  }

  // ⑥ finalize
  r = await req('POST', `/${uid}/finalize`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.data.status, 'completed_with_issues');
  const outA = r.body.data.designs.find((d) => d.family_name === famA);
  const outB = r.body.data.designs.find((d) => d.family_name === famB);
  assert.strictEqual(outA.outcome, 'published');
  assert.strictEqual(outB.outcome, 'draft');
  assert.ok(outB.warnings.some((w) => w.field === 'tag_ids'));
  assert.strictEqual((await TemplateFamily.findOne({ where: { name: famA } })).status, 'active');
  assert.strictEqual((await TemplateFamily.findOne({ where: { name: famB } })).status, 'draft');

  // list shows it
  r = await h.request('GET', `${P}?limit=50`, { token: READER });
  assert.ok(r.body.data.some((b) => b.uid === uid));

  // re-import of an existing version is refused; a new size joins the live design
  r = await req('POST', '', { label: `again ${tag}`, manifest: csv([
    [famA, '', '', '', '', '', '', 'en', size.slug, 'alpha2/en', ''],
    [famA, '', '', `ti-three-${tag}`, '', '', '', 'en', size2.slug, 'alpha2/en-story', ''],
  ]) });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.data.items[0].stage, 'invalid');
  assert.ok(r.body.data.items[0].errors.some((e) => e.message.includes('already has a version')));
  assert.strictEqual(r.body.data.items[1].stage, 'awaiting_files');
  assert.strictEqual(r.body.data.designs[0].existing, true);
});

test('dry-run errors: references, names, lookups, disagreements, duplicates, kinds', async () => {
  const fam = `TI Gamma ${tag}`;
  let r = await req('POST', '', { label: `errors ${tag}`, manifest: csv([
    [fam, `no-such-cat-${tag}`, '', 'x', '', '', '', 'en', size.slug, 'g/en', ''],
    [fam, '', '', 'y', '', '', '', 'en', size.slug, 'g/en2', ''],
    [`TI Delta ${tag}`, '', '', '', '', 'banner', '', 'en', size.slug, 'd/en', 'thumb.gif'],
    [`TI Eps ${tag}`, '', '', '', '', '', '', 'en', size.slug, 'e/en', ''],
    [`TI Eps ${tag}`, '', '', '', '', '', '', '', size2.slug, 'e/free', ''],
    [`TI Zeta ${tag}`, '', '', '', '', '', '', 'en', `no-size-${tag}`, 'z/en', ''],
    [`TI Eta ${tag}`, '', '', '', '', '', '', 'en', size.slug, 'g/en', ''],
  ]) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const items = r.body.data.items;
  const msgs = (i) => items[i].errors.map((e) => e.message).join(' | ');
  assert.match(msgs(0), /template category .* not found/);
  assert.match(msgs(0), /disagree on tags/);
  assert.match(msgs(1), /same language and size as row 1/);
  assert.match(msgs(2), /template_type must be one of/);
  assert.match(msgs(2), /thumbnail must be/);
  assert.match(msgs(3), /mixes text-free rows/);
  assert.match(msgs(4), /mixes text-free rows/);
  assert.match(msgs(5), /size .* not found/);
  assert.match(msgs(6), /folder is already used by row 1/);
  assert.ok(items.every((i) => i.stage === 'invalid'));

  // file errors on an otherwise valid row
  r = await req('POST', '', { label: `files ${tag}`, manifest: csv([[`TI Theta ${tag}`, '', '', '', '', '', '', 'en', size.slug, 't/en', '']]) });
  const uid = r.body.data.uid;
  r = await req('POST', `/${uid}/files`, { items: [{ row: 1, content: design('missing.png', 'my bg.png', 'clip.exe.mp4'), files: [
    { name: 'my bg.png', size: 10 }, { name: 'clip.exe.mp4', size: 10 }, { name: 'thumbnail.png', size: 10 },
  ] }] });
  assert.strictEqual(r.status, 200);
  const row = r.body.data.items[0];
  assert.strictEqual(row.stage, 'invalid');
  const text = row.errors.map((e) => e.message).join(' | ');
  assert.ok(!/missing\.png/.test(text), 'a missing referenced file is not an error');
  assert.ok(row.warnings.some((w) => w.level === 'warning' && w.scope === 'files' && /uses "missing.png", which is not in the bundle/.test(w.message)));
  assert.match(text, /"my bg.png": rename it/);
  assert.ok(!/Poppins/.test(text), 'fonts are never required');

  // fixed folder: send the row again
  r = await req('POST', `/${uid}/files`, { items: [{ row: 1, content: design('bg.png'), files: [{ name: 'bg.png', size: 10 }, { name: 'thumbnail.png', size: 10 }] }] });
  assert.strictEqual(r.body.data.items[0].stage, 'valid', JSON.stringify(r.body.data.items[0].errors));

  r = await req('POST', `/${uid}/files`, { items: [{ row: 1, content: '{not json', files: [] }] });
  assert.match(r.body.data.items[0].errors.map((e) => e.message).join(), /not valid JSON/);
});

test('ZIP bundles: any design file name, thumbnail detected, paths uploaded with a warning', async () => {
  const fam = `TI Lambda ${tag}`;
  let r = await req('POST', '', { label: `zip ${tag}`, manifest: csv([
    [fam, category.slug, '', `ti-zip-${tag}`, '', '', '', 'en', size.slug, 'lambda-en.zip', ''],
    [fam, '', '', '', '', '', '', other.code, size.slug, 'lambda-other.zip', ''],
  ]) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const uid = r.body.data.uid;
  assert.deepStrictEqual(r.body.data.items.map((i) => i.folder), ['lambda-en.zip', 'lambda-other.zip']);
  assert.strictEqual(r.body.data.designs.length, 1, 'two ZIPs, one design by family_name');
  assert.strictEqual(r.body.data.items[0].thumbnail, null, 'unknown until the files are sent');

  r = await req('POST', `/${uid}/files`, { items: [
    { row: 1, content: design('bg.png', 'assets/logo.svg', 'assets/library-only.png', 'anim.json'), files: [
      { name: 'template.json', size: 100 }, { name: 'anim.json', size: 50 }, { name: 'Thumbnail.JPG', size: 900 },
      { name: 'bg.png', size: 10 }, { name: 'logo.svg', size: 20 },
    ] },
    { row: 2, content: design('bg.png'), files: [{ name: 'design.json', size: 100 }, { name: 'stray.json', size: 5 }, { name: 'bg.png', size: 10 }] },
  ] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const [one, two] = r.body.data.items;
  assert.strictEqual(one.stage, 'valid', JSON.stringify(one.errors));
  assert.strictEqual(one.thumbnail, 'Thumbnail.JPG');
  assert.deepStrictEqual(one.files.map((f) => f.name).sort(), ['Thumbnail.JPG', 'anim.json', 'bg.png', 'logo.svg']);
  assert.strictEqual(one.warnings.filter((w) => w.scope === 'files').length, 1, JSON.stringify(one.warnings));
  assert.ok(one.warnings.some((w) => w.message.includes('"assets/logo.svg" with a path')));
  assert.strictEqual(two.stage, 'invalid');
  assert.ok(two.errors.some((e) => /no thumbnail in the bundle/.test(e.message)));
  assert.ok(two.warnings.some((w) => w.message.includes('"stray.json" is not used')));
  assert.ok(!two.warnings.some((w) => w.message.startsWith('"design.json"')));

  // row 2 fixed; png wins over webp; then webp alone is detected afresh
  for (const [names, want] of [[['thumbnail.webp', 'thumbnail.png'], 'thumbnail.png'], [['thumbnail.webp'], 'thumbnail.webp']]) {
    r = await req('POST', `/${uid}/files`, { items: [{ row: 2, content: design('bg.png'), files: ['t.json', 'bg.png', ...names].map((name) => ({ name, size: 10 })) }] });
    assert.strictEqual(r.body.data.items[1].stage, 'valid', JSON.stringify(r.body.data.items[1].errors));
    assert.strictEqual(r.body.data.items[1].thumbnail, want);
  }

  r = await req('POST', `/${uid}/start`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await upload(uid, 1);
  r = await req('POST', `/${uid}/items/1/complete`);
  assert.strictEqual(r.body.data.result, 'published', JSON.stringify(r.body));
  const v = await Template.findOne({ where: { uid: r.body.data.template_uid } });
  assert.strictEqual(v.thumbnail_s3_key, `templates/${v.uid}/Thumbnail.JPG`);
});

test('editor export bundle: three UUID PNGs by URL are uploaded, no missing or unused files', async () => {
  const fam = `TI Food ${tag}`;
  let r = await req('POST', '', { label: `food ${tag}`, manifest: csv([
    [fam, category.slug, '', `ti-food-${tag}`, '', '', '', 'en', size.slug, 'Food_st_en_002.zip', ''],
  ]) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const uid = r.body.data.uid;
  r = await req('POST', `/${uid}/files`, { items: [{ row: 1, content: editorExport(), files: [
    { name: 'template.json', size: 22471 }, { name: 'thumbnail.jpg', size: 165454 },
    ...UUIDS.map((u) => ({ name: `${u}.png`, size: 600000 })),
  ] }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const row = r.body.data.items[0];
  assert.strictEqual(row.stage, 'valid', JSON.stringify(row.errors));
  assert.deepStrictEqual(row.files.map((f) => f.name).sort(), [...UUIDS.map((u) => `${u}.png`), 'thumbnail.jpg'].sort());
  assert.ok(!row.warnings.some((w) => /not in the bundle|is not used/.test(w.message)), JSON.stringify(row.warnings));
  assert.ok(row.warnings.some((w) => w.level === 'info' && /3 bundled file\(s\) by full URL/.test(w.message)));
  assert.ok(!r.body.data.designs[0].warnings.some((w) => w.field === 'files'));

  // one UUID PNG left out of the bundle: a warning per file, the row stays valid and publishable
  const json = JSON.parse(editorExport());
  json.pages[0].fabric.objects.push({ type: 'text', fontUrl: `${S3_HOST}/Poppins.ttf` });
  r = await req('POST', `/${uid}/files`, { items: [{ row: 1, content: JSON.stringify(json), files: [
    { name: 'template.json', size: 22471 }, { name: 'thumbnail.jpg', size: 165454 },
    ...UUIDS.slice(1).map((u) => ({ name: `${u}.png`, size: 600000 })),
  ] }] });
  const again = r.body.data.items[0];
  assert.strictEqual(again.stage, 'valid', JSON.stringify(again.errors));
  const urlWarnings = again.warnings.filter((w) => /from temp-assets\.s3\.ap-south-1\.amazonaws\.com, which is not in the bundle/.test(w.message));
  assert.strictEqual(urlWarnings.length, 1, 'once per file name, even though three fields use it; fonts excepted');
  assert.deepStrictEqual({ scope: urlWarnings[0].scope, field: urlWarnings[0].field, level: urlWarnings[0].level }, { scope: 'files', field: 'files', level: 'warning' });
  assert.ok(urlWarnings[0].message.includes(`"${UUIDS[0]}.png"`));
  assert.ok(!r.body.data.designs[0].warnings.some((w) => w.field === 'files'), 'a URL still loads: no publish block');
});

test('a missing referenced file is a warning: the row imports, version and design stay drafts', async () => {
  const fam = `TI Mu ${tag}`;
  let r = await req('POST', '', { label: `missing ${tag}`, manifest: csv([
    [fam, category.slug, '', `ti-mu-${tag}`, '', '', '', 'en', size.slug, 'mu-en.zip', ''],
    [fam, '', '', '', '', '', '', other.code, size.slug, 'mu-other.zip', ''],
  ]) });
  const uid = r.body.data.uid;
  r = await req('POST', `/${uid}/files`, { items: [
    { row: 1, content: design('bg.png'), files: [{ name: 'bg.png', size: 10 }, { name: 'thumbnail.png', size: 10 }] },
    { row: 2, content: design('bg.png', 'pattern.png'), files: [{ name: 'bg.png', size: 10 }, { name: 'thumbnail.png', size: 10 }] },
  ] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const two = r.body.data.items[1];
  assert.strictEqual(two.stage, 'valid', JSON.stringify(two.errors));
  assert.deepStrictEqual(two.errors, []);
  const w = two.warnings.find((x) => x.message.includes('"pattern.png"'));
  assert.deepStrictEqual({ scope: w.scope, field: w.field, level: w.level }, { scope: 'files', field: 'files', level: 'warning' });
  assert.ok(r.body.data.designs[0].warnings.some((x) => x.scope === 'publish' && x.field === 'files' && /Row\(s\) 2/.test(x.message)), 'predicted draft');

  // a missing thumbnail is still an error
  r = await req('POST', `/${uid}/files`, { items: [{ row: 2, content: design('bg.png', 'thumbnail.png'), files: [{ name: 'bg.png', size: 10 }] }] });
  assert.strictEqual(r.body.data.items[1].stage, 'invalid');
  assert.ok(r.body.data.items[1].errors.some((e) => e.field === 'thumbnail'));
  r = await req('POST', `/${uid}/files`, { items: [{ row: 2, content: design('bg.png', 'pattern.png'), files: [{ name: 'bg.png', size: 10 }, { name: 'thumbnail.png', size: 10 }] }] });
  assert.strictEqual(r.body.data.status, 'validated');

  r = await req('POST', `/${uid}/start`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  for (const row of [1, 2]) await upload(uid, row);
  r = await req('POST', `/${uid}/items/1/complete`);
  assert.strictEqual(r.body.data.result, 'published', JSON.stringify(r.body));
  r = await req('POST', `/${uid}/items/2/complete`);
  assert.strictEqual(r.body.data.stage, 'completed');
  assert.strictEqual(r.body.data.result, 'draft');
  assert.ok(r.body.data.warnings.some((x) => x.scope === 'publish' && x.field === 'files' && x.message.includes('pattern.png')));

  r = await req('POST', `/${uid}/finalize`);
  const out = r.body.data.designs[0];
  assert.strictEqual(out.outcome, 'draft', JSON.stringify(out));
  assert.ok(out.warnings.some((x) => x.field === 'files'));
  assert.strictEqual((await TemplateFamily.findOne({ where: { name: fam } })).status, 'draft');
});

test('PUT manifest replaces the rows of an import that has not started', async () => {
  const fam = `TI Nu ${tag}`;
  let r = await req('POST', '', { label: `replace ${tag}`, manifest: csv([
    [fam, category.slug, '', `ti-nu-${tag}`, '', '', '', 'en', size.slug, 'nu-en.zip', ''],
    [fam, '', '', '', '', '', '', other.code, `no-size-${tag}`, 'nu-other.zip', ''],
  ]) });
  const uid = r.body.data.uid;
  assert.deepStrictEqual(r.body.data.items.map((i) => i.stage), ['awaiting_files', 'invalid']);
  r = await req('POST', `/${uid}/files`, { items: [{ row: 1, content: design('bg.png'), files: [{ name: 'bg.png', size: 10 }, { name: 'thumbnail.png', size: 10 }] }] });
  assert.strictEqual(r.body.data.items[0].stage, 'valid');
  assert.strictEqual(r.body.data.status, 'validated');

  // permissions, unknown uid, unusable manifest
  r = await h.request('PUT', `${P}/${uid}/manifest`, { token: READER, body: { manifest: 'x' } });
  assert.strictEqual(r.status, 403);
  r = await req('PUT', `/${crypto.randomUUID()}/manifest`, { manifest: csv([[fam, '', '', '', '', '', '', 'en', size.slug, 'a', '']]) });
  assert.strictEqual(r.status, 404);
  r = await req('PUT', `/${uid}/manifest`, { manifest: 'family_name,language\nX,en' });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));

  // fixed row 2, renamed row 1's ZIP, one row added; a comment line is not a row
  r = await req('PUT', `/${uid}/manifest`, { manifest: [
    'family_name,category,industries,tags,is_premium,template_type,search_keywords,language,size,folder,thumbnail',
    '# a comment',
    [fam, category.slug, '', `ti-nu-${tag}`, '', '', '', 'en', size.slug, 'nu-en-v2.zip', ''].join(','),
    [fam, '', '', '', '', '', '', other.code, size.slug, 'nu-other.zip', ''].join(','),
    [fam, '', '', '', '', '', '', other.code, size.slug, 'nu-dupe.zip', ''].join(','),
  ].join('\n') });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const data = r.body.data;
  assert.strictEqual(data.uid, uid);
  assert.strictEqual(data.status, 'draft');
  assert.strictEqual(data.total_items, 3);
  assert.deepStrictEqual(data.items.map((i) => [i.row, i.line, i.folder, i.stage]), [
    [1, 3, 'nu-en-v2.zip', 'awaiting_files'],
    [2, 4, 'nu-other.zip', 'awaiting_files'],
    [3, 5, 'nu-dupe.zip', 'invalid'],
  ]);
  assert.deepStrictEqual(data.items[0].files, [], 'earlier file checks are dropped');
  assert.ok(data.items[2].errors.every((e) => e.scope === 'manifest') && data.items[2].errors.length);
  const got = await req('GET', `/${uid}`);
  assert.deepStrictEqual(got.body.data.items, data.items, 'same shape as GET');

  // after start: refused
  r = await req('POST', `/${uid}/files`, { items: [1, 2].map((row) => ({ row, content: design('bg.png'), files: [{ name: 'bg.png', size: 10 }, { name: 'thumbnail.png', size: 10 }] })) });
  assert.strictEqual(r.body.data.status, 'validated');
  r = await req('POST', `/${uid}/start`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await req('PUT', `/${uid}/manifest`, { manifest: csv([[fam, '', '', '', '', '', '', 'en', size.slug, 'z.zip', '']]) });
  assert.strictEqual(r.status, 409);
  assert.match(JSON.stringify(r.body), /only be replaced before it is started/);
});

test('start is refused while rows await files', async () => {
  let r = await req('POST', '', { label: `wait ${tag}`, manifest: csv([[`TI Iota ${tag}`, '', '', '', '', '', '', 'en', size.slug, 'i/en', '']]) });
  const uid = r.body.data.uid;
  r = await req('POST', `/${uid}/start`);
  assert.strictEqual(r.status, 409);
  r = await req('POST', `/${uid}/items/1/presign`);
  assert.strictEqual(r.status, 409);
});

test('cancel removes the drafts this import created, keeps its tags', async () => {
  const fam = `TI Kappa ${tag}`;
  let r = await req('POST', '', { label: `cancel ${tag}`, manifest: csv([[fam, '', '', `ti-kept-${tag}`, '', '', '', 'en', size.slug, 'k/en', '']]) });
  const uid = r.body.data.uid;
  await req('POST', `/${uid}/files`, { items: [{ row: 1, content: design('bg.png'), files: [{ name: 'bg.png', size: 10 }, { name: 'thumbnail.png', size: 10 }] }] });
  r = await req('POST', `/${uid}/start`);
  const versionUid = r.body.data.items[0].template_uid;
  await upload(uid, 1);
  assert.ok(bucket.has(`templates/${versionUid}/bg.png`));

  r = await req('DELETE', `/${uid}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.data.status, 'cancelled');
  assert.strictEqual(await TemplateFamily.count({ where: { name: fam } }), 0);
  assert.strictEqual(await Template.count({ where: { uid: versionUid } }), 0);
  assert.ok(!bucket.has(`templates/${versionUid}/bg.png`));
  assert.ok(await Tag.findOne({ where: { name: `ti-kept-${tag}` } }));

  r = await req('POST', `/${uid}/start`);
  assert.strictEqual(r.status, 409);
});
