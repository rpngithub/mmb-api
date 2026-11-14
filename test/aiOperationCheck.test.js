// G1: an operation's input schema is checked against every route's adapter when
// either is saved — required fields, fields the model never receives, enum values
// it cannot take, Google prompt placeholders with no field behind them.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { v4: uuid } = require('uuid');

const h = require('./helpers');
const { models } = h;
const { AdminUser, AiProvider, AiOperation, AiOperationRoute } = models;

const magnific = require('../src/ai/providers/magnific');
const google   = require('../src/ai/providers/google');
const fake     = require('../src/ai/providers/fake');
const operationCheck = require('../src/ai/operationCheck');
const m063 = require('../src/db/migrations/20260101000063-ai-social-posts');
const m064 = require('../src/db/migrations/20260101000064-ai-operation-plans');

const P = '/api/v1/admin/ai';
const track = { ops: [] };
let admin;
let googleRow;
let seq = 0;

before(async () => {
  await models.sequelize.authenticate();
  await h.start();
  admin = h.adminToken(['*'], (await AdminUser.findOne({ where: { email: 'admin@makemybrand.com' } })).id);
  googleRow = await AiProvider.findOne({ where: { key: 'google' } });
});

after(async () => {
  if (track.ops.length) {
    await AiOperationRoute.destroy({ where: { operation_id: track.ops } });
    await AiOperation.destroy({ where: { id: track.ops } });
  }
  await h.stop();
  await models.sequelize.close();
});

const req = (method, path, body) => h.request(method, `${P}${path}`, { token: admin, body });
const check = (adapter, model, inputSchema, fixedParams = {}) => adapter.checkOperation({ model, fixedParams, inputSchema });
const GOOGLE_FIXED = (over = {}) => ({
  system_prompt: 'Write captions.', output_schema: { type: 'object', properties: {} }, max_output_tokens: 1024,
  thinking: { level: 'minimal' }, input_cents_per_mtok: 30, output_cents_per_mtok: 250, ...over,
});

// ---------- the shipped catalogue fits ----------

test('the seeded operations fit their routes: captions on google, image.standard / image.hd on Nano Banana Pro', () => {
  for (const [platform, p] of Object.entries(m063.PLATFORMS)) {
    const fixed = { system_prompt: m063.BASE_PROMPT, user_template: m063.USER_TEMPLATE, output_schema: m063.outputSchema(p) };
    assert.deepEqual(check(google, m063.MODEL, m063.INPUT_SCHEMA, fixed), [], platform);
  }
  for (const op of m064.IMAGE_OPS) {
    assert.deepEqual(check(magnific, 'nano-banana-pro', m064.IMAGE_SCHEMA, { resolution: op.resolution }), [], op.key);
  }
  assert.equal(fake.checkOperation, undefined, 'the fake adapter takes anything');
  assert.deepEqual(operationCheck.checkRoute(fake, { model: 'x' }, { fields: { anything: { type: 'string' } } }), []);
});

// ---------- magnific ----------

test('magnific: prompt required, unknown fields refused, too many references, unmapped aspect ratios, bad qualities', () => {
  const p = (extra = {}) => ({ fields: { prompt: { type: 'string', required: true }, ...extra } });
  assert.deepEqual(check(magnific, 'nano-banana-pro', p()), []);
  assert.match(check(magnific, 'nano-banana-pro', { fields: {} }).join(), /needs a string field "prompt"/);
  assert.match(check(magnific, 'nano-banana-pro', { fields: { prompt: { type: 'string' } } }).join(), /must be required/);
  assert.match(check(magnific, 'nano-banana-pro', p({ style: { type: 'enum', values: ['a'] } })).join(), /field "style" is never sent/);
  assert.match(check(magnific, 'nano-banana-pro', p({ reference_images: { type: 'media_list', max: 5 } })).join(), /at most 3/);
  assert.deepEqual(check(magnific, 'nano-banana-2-1', p({ reference_images: { type: 'media_list', max: 5 } })), [], 'that one takes 14');
  assert.match(check(magnific, 'nano-banana-pro', p({ reference_images: { type: 'media' } })).join(), /must be of type media_list/);

  const ar = p({ aspect_ratio: { type: 'enum', values: ['1:1', '9:16'] } });
  assert.deepEqual(check(magnific, 'gpt-image-2', ar), [], 'no map: values pass through');
  assert.match(check(magnific, 'gpt-image-2', ar, { aspect_ratio_map: { '1:1': 'square_1_1' } }).join(), /9:16 has no entry/);

  const q = p({ quality: { type: 'enum', values: ['low', 'ultra'] } });
  assert.match(check(magnific, 'gpt-image-2', q).join(), /quality ultra is not one of/);
  assert.match(check(magnific, 'nano-banana-pro', q).join(), /field "quality" is never sent/, 'nano takes no quality');

  assert.deepEqual(check(magnific, 'remove-background', { fields: { image: { type: 'media', required: true } } }), []);
  assert.match(check(magnific, 'remove-background', { fields: { image: { type: 'media', required: true }, prompt: { type: 'string' } } }).join(), /"prompt" is never sent/);
  assert.match(check(magnific, 'remove-background', { fields: { image: { type: 'media' } } }).join(), /must be required/);
  // The context builder's fields are the server's, whoever the provider is.
  assert.deepEqual(check(magnific, 'nano-banana-pro', { ...p({ project: { type: 'project' } }), context: ['project'] }), []);
});

// ---------- google ----------

test('google: every placeholder has a field, every field reaches the prompt, no uploaded images', () => {
  const schema = { fields: { notes: { type: 'string' } } };
  assert.deepEqual(check(google, 'gemini-3.5-flash-lite', schema, GOOGLE_FIXED({ user_template: 'Notes: {{notes}}' })), []);
  assert.deepEqual(check(google, 'gemini-3.5-flash-lite', schema, GOOGLE_FIXED()), [], 'the default template sends {{input_json}}');
  assert.match(check(google, 'gemini-3.5-flash-lite', schema, GOOGLE_FIXED({ user_template: 'Topic: {{topic}} {{notes}}' })).join(), /uses \{\{topic\}\} but the operation has no "topic" field/);
  assert.match(check(google, 'gemini-3.5-flash-lite', { fields: { notes: { type: 'string' }, tone: { type: 'enum', values: ['fun'] } } },
    GOOGLE_FIXED({ user_template: '{{notes}}' })).join(), /field "tone" is never sent/);
  assert.match(check(google, 'gemini-3.5-flash-lite', schema, GOOGLE_FIXED({ user_template: '{{brand_context}} {{notes}}' })).join(), /declares no "context"/);
  assert.match(check(google, 'gemini-3.5-flash-lite', { fields: { photo: { type: 'media' } } }, GOOGLE_FIXED()).join(), /take no uploaded images/);
});

// ---------- wired into admin saves ----------

test('admin: a route that does not fit its operation is a 400 — and so is an operation edit that breaks a route', async () => {
  const create = await req('POST', '/operations', {
    key: `tst.g1.${Date.now()}.${seq += 1}`, label: 'TST G1', credits: 1, unit: 'text', ledger_source: 'text_generation',
    input_schema: { fields: { notes: { type: 'string', max: 300 } } },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const op = await AiOperation.findOne({ where: { uid: create.body.data.uid } });
  track.ops.push(op.id);

  const badRoute = await req('POST', '/routes', {
    operation_id: op.id, provider_id: googleRow.id, model: 'gemini-3.5-flash-lite', provider_units: 0.2,
    fixed_params: GOOGLE_FIXED({ user_template: 'Write about {{topic}}' }),
  });
  assert.equal(badRoute.status, 400);
  assert.match(JSON.stringify(badRoute.body), /\{\{topic\}\}/);
  assert.match(JSON.stringify(badRoute.body), /field \\"notes\\" is never sent/);

  const inactive = await req('POST', '/routes', {
    operation_id: op.id, provider_id: googleRow.id, model: 'gemini-3.5-flash-lite', provider_units: 0.2, is_active: false,
    fixed_params: GOOGLE_FIXED({ user_template: 'Write about {{topic}}' }),
  });
  assert.equal(inactive.status, 201, 'an inactive route is checked when switched on');
  assert.equal((await req('PATCH', `/routes/${inactive.body.data.uid}`, { is_active: true })).status, 400);

  const good = await req('POST', '/routes', {
    operation_id: op.id, provider_id: googleRow.id, model: 'gemini-3.5-flash-lite', provider_units: 0.2,
    fixed_params: GOOGLE_FIXED({ user_template: 'Notes: {{notes}}' }),
  });
  assert.equal(good.status, 201, JSON.stringify(good.body));

  // Renaming the field the active route's prompt uses would break it.
  const rename = await req('PATCH', `/operations/${op.uid}`, { input_schema: { fields: { remarks: { type: 'string' } } } });
  assert.equal(rename.status, 400);
  assert.match(JSON.stringify(rename.body), /\{\{notes\}\}/);
  assert.equal((await req('PATCH', `/operations/${op.uid}`, { input_schema: { fields: { notes: { type: 'string', max: 500 } } } })).status, 200);
});
