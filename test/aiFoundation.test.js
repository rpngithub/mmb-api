// AI Dev Kit phase 1 — the shared foundation the six features build on:
// input schema rules (one_of, max_words, enum options + match), context rules,
// the shared prompt renderer, Magnific prompt templates and fixed counts, Google
// image and audio output, uploaded images sent inline, audio results, and the
// transparency check. HTTP and S3 are stubbed — no network, no key.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { v4: uuid } = require('uuid');

process.env.AI_PROVIDER_GOOGLE_API_KEY = 'AIza-test-key-not-real';

const h = require('./helpers');
const { models } = h;
const { AiProvider, AiOperation, AiOperationRoute, AiJob, User, UserSubscription, Plan, PlanFeature, FeatureType,
  Business, BusinessCategory, UserUpload, UserQuotaCounter } = models;

const inputSchema = require('../src/ai/inputSchema');
const promptTemplate = require('../src/ai/promptTemplate');
const magnific = require('../src/ai/providers/magnific');
const google = require('../src/ai/providers/google');
const resultStore = require('../src/ai/resultStore');
const aiHttp = require('../src/ai/http');
const worker = require('../src/ai/worker');
const routing = require('../src/ai/routing');
const credentialStore = require('../src/ai/credentialStore');
const s3 = require('../src/utils/s3Helper');
const { PNG_1PX } = require('../src/ai/providers/fake');

const P = '/api/v1';
const orig = { request: aiHttp.request, getObject: s3.getObjectBuffer, uploadFile: s3.uploadFile };
const calls = [];
const uploaded = [];
const track = { users: [], ops: [], plans: [], businesses: [] };
let provider;
let providerOriginal;
let plan;
let aiFeatureId;
let industry;
let seq = 0;
let reply = () => ({ status: 500, headers: {}, data: {} });

// A PNG that cannot hold transparency: PNG_1PX (RGBA) with colour type 2 (RGB).
const PNG_OPAQUE = Buffer.from(PNG_1PX); PNG_OPAQUE[25] = 2;
const RATES = { input_cents_per_mtok: 30, output_cents_per_mtok: 3000 };
const usage = { promptTokenCount: 1000, candidatesTokenCount: 1290, thoughtsTokenCount: 0 };
const part = (mimeType, buf) => ({ inlineData: { mimeType, data: buf.toString('base64') } });
const answerWith = (...parts) => ({ candidates: [{ content: { parts }, finishReason: 'STOP' }], usageMetadata: usage });

before(async () => {
  await models.sequelize.authenticate();
  await h.start();
  aiHttp.request = async (opts) => { aiHttp.assertAllowedUrl(opts.url, opts.allowedHosts); calls.push(opts); return reply(opts); };
  s3.getObjectBuffer = async () => PNG_1PX;
  s3.uploadFile = async (key) => { uploaded.push(key); };

  provider = await AiProvider.findOne({ where: { key: 'google' } });
  assert.ok(provider, 'migration 063 seeds the google provider');
  providerOriginal = provider.toJSON();
  await provider.update({ status: 'active', credential_source: 'env' });

  industry = await BusinessCategory.findOne({ attributes: ['id', 'name'] });
  assert.ok(industry, 'the test database has at least one industry');
  aiFeatureId = (await FeatureType.findOne({ where: { key: 'ai_credits' } })).id;
  plan = await Plan.create({ uid: uuid(), name: `TST Foundation Plan ${Date.now()}`, plan_type: 'subscription', status: 'inactive' });
  track.plans.push(plan.id);
  await PlanFeature.create({ plan_id: plan.id, feature_type_id: aiFeatureId, value: 100 });
});

after(async () => {
  aiHttp.request = orig.request;
  s3.getObjectBuffer = orig.getObject;
  s3.uploadFile = orig.uploadFile;
  if (track.users.length) {
    await AiJob.destroy({ where: { user_id: track.users } });
    await UserUpload.destroy({ where: { user_id: track.users } });
  }
  if (track.ops.length) {
    await AiJob.destroy({ where: { operation_id: track.ops } });
    await AiOperationRoute.destroy({ where: { operation_id: track.ops } });
    await AiOperation.destroy({ where: { id: track.ops } });
  }
  if (track.businesses.length) await Business.destroy({ where: { id: track.businesses } });
  if (track.users.length) await User.destroy({ where: { id: track.users } });
  if (track.plans.length) {
    await PlanFeature.destroy({ where: { plan_id: track.plans } });
    await Plan.destroy({ where: { id: track.plans } });
  }
  await AiProvider.update({ status: providerOriginal.status, credential_source: providerOriginal.credential_source }, { where: { id: providerOriginal.id } });
  routing.clearTrips();
  routing.clearCircuits();
  credentialStore.clearCache();
  await h.stop();
  await models.sequelize.close();
});

beforeEach(() => {
  calls.length = 0;
  uploaded.length = 0;
  worker.resetBuckets();
  routing.clearCircuits();
  credentialStore.clearCache();
});

// ---------- fixtures ----------

async function mkUser({ business = true, withIndustry = true } = {}) {
  const user = await User.create({ uid: uuid(), name: 'TST Foundation', phone: `3${String((Date.now() + (seq += 23)) % 1000000000).padStart(9, '0')}` });
  track.users.push(user.id);
  await UserSubscription.create({ uid: uuid(), user_id: user.id, plan_id: plan.id, sub_type: 'regular', status: 'active', starts_at: new Date(), ends_at: new Date(Date.now() + 30 * 864e5), amount_paid: 1 });
  if (business) {
    const biz = await Business.create({
      user_id: user.id, name: 'Kavya Boutique', city: 'Coimbatore', state: 'Tamil Nadu',
      category_id: withIndustry ? industry.id : null,
    });
    track.businesses.push(biz.id);
  }
  return { id: user.id, uid: user.uid, token: h.userTokenFor(user.id) };
}

async function mkUpload(u) {
  return UserUpload.create({ user_id: u.id, s3_key: `users/${u.uid}/media/${uuid()}.png`, slot: 'media_library', bytes: PNG_1PX.length, content_type: 'image/png' });
}

async function mkOp(schema, fixed, model = 'gemini-nano-banana-2.1') {
  assert.equal(inputSchema.checkDefinition(schema), null, 'the test schema is valid');
  assert.equal(google.validateRoute({ model, fixedParams: fixed }), null, 'the test route is valid');
  assert.deepEqual(google.checkOperation({ model, fixedParams: fixed, inputSchema: schema }), [], 'schema fits route');
  const op = await AiOperation.create({
    key: `tst.foundation.${Date.now()}.${seq += 1}`, label: 'TST foundation', credits: 1, unit: 'image', ledger_source: 'image_generation',
    is_active: true, input_schema: schema,
  });
  track.ops.push(op.id);
  await AiOperationRoute.create({ operation_id: op.id, provider_id: provider.id, model, provider_units: 1, fixed_params: fixed });
  return op;
}

const submit = (u, key, body) => h.request('POST', `${P}/ai/operations/${key}`, { token: u.token, body, headers: { 'Idempotency-Key': uuid() } });
const used = async (userId) => Number((await UserQuotaCounter.findOne({ where: { user_id: userId, feature_type_id: aiFeatureId } }))?.used || 0);
const runWorker = async () => { await worker.dispatch(new Date()); await worker.drain(); };

// ---------- F1 input schema ----------

const VOICES = {
  fields: {
    voice_gender: { type: 'enum', values: ['male', 'female'], required: true },
    language: { type: 'enum', values: ['en', 'ta', 'hi'], required: true },
    voice: {
      type: 'enum', required: true,
      options: [
        { value: 'asha', label: 'Asha', gender: 'female', languages: ['en', 'hi'] },
        { value: 'ravi', label: 'Ravi', gender: 'male', languages: ['en', 'ta'] },
      ],
      match: { gender: 'voice_gender', languages: 'language' },
    },
    text: { type: 'string', required: true, max_words: 5 },
  },
};

test('F1: one_of takes exactly one of the group — neither or both is a 400', () => {
  const schema = { fields: { image: { type: 'media' }, project: { type: 'project' }, note: { type: 'string' } }, one_of: [['image', 'project']] };
  assert.equal(inputSchema.checkDefinition(schema), null);
  assert.deepEqual(inputSchema.validateInput(schema, { image: uuid() }).project, undefined);
  assert.ok(inputSchema.validateInput(schema, { project: uuid() }).project);
  assert.throws(() => inputSchema.validateInput(schema, { note: 'x' }), (e) => e.details?.[0]?.field === 'image|project');
  assert.throws(() => inputSchema.validateInput(schema, { image: uuid(), project: uuid() }), /Validation failed/);

  assert.match(inputSchema.checkDefinition({ fields: { image: { type: 'media', required: true }, project: { type: 'project' } }, one_of: [['image', 'project']] }), /cannot be required/);
  assert.match(inputSchema.checkDefinition({ fields: { image: { type: 'media' } }, one_of: [['image', 'photo']] }), /not a field/);
  assert.match(inputSchema.checkDefinition({ fields: { image: { type: 'media' } }, one_of: [['image']] }), /at least two/);
});

test('F1: max_words counts words, in Tamil and Hindi too', () => {
  assert.equal(inputSchema.countWords('  வணக்கம் நண்பர்களே  இன்று '), 3);
  assert.equal(inputSchema.countWords('नमस्ते दोस्तों'), 2);
  const v = inputSchema.validateInput({ fields: { text: { type: 'string', max_words: 3 } } }, { text: 'one two three' });
  assert.equal(v.text, 'one two three');
  assert.throws(() => inputSchema.validateInput({ fields: { text: { type: 'string', max_words: 3 } } }, { text: 'one two three four' }),
    (e) => /at most 3 words/.test(e.details[0].message));
  assert.match(inputSchema.checkDefinition({ fields: { n: { type: 'integer', max_words: 3 } } }), /max_words/);
});

test('F1: enum options validate like values, and match ties the voice to gender and language', () => {
  assert.equal(inputSchema.checkDefinition(VOICES), null);
  assert.deepEqual(inputSchema.enumValues(VOICES.fields.voice), ['asha', 'ravi']);
  const ok = inputSchema.validateInput(VOICES, { voice_gender: 'female', language: 'hi', voice: 'asha', text: 'hello there' });
  assert.equal(ok.voice, 'asha');
  assert.throws(() => inputSchema.validateInput(VOICES, { voice_gender: 'male', language: 'en', voice: 'asha', text: 'hi' }),
    (e) => e.details[0].field === 'voice' && /voice_gender male/.test(e.details[0].message));
  assert.throws(() => inputSchema.validateInput(VOICES, { voice_gender: 'female', language: 'ta', voice: 'asha', text: 'hi' }),
    (e) => /language ta/.test(e.details[0].message));
  assert.throws(() => inputSchema.validateInput(VOICES, { voice_gender: 'female', language: 'en', voice: 'zara', text: 'hi' }), /Validation failed/);

  const bad = (voice) => inputSchema.checkDefinition({ fields: { ...VOICES.fields, voice } });
  assert.match(bad({ type: 'enum', options: [{ value: 'a' }, { value: 'a' }] }), /unique/);
  assert.match(bad({ type: 'enum', options: [{ label: 'x' }] }), /string "value"/);
  assert.match(bad({ type: 'enum', options: [{ value: 'a' }], values: ['a'] }), /not both/);
  assert.match(bad({ type: 'enum', options: [{ value: 'a' }], match: { gender: 'nope' } }), /not another field/);
  assert.match(bad({ type: 'enum', options: [{ value: 'a' }], match: { gender: 'voice_gender' } }), /needs "gender"/);
});

test('F1/F2: context_rules are checked', () => {
  assert.equal(inputSchema.checkDefinition({ fields: {}, context: ['business'], context_rules: { need_subject: false, need_industry: true } }), null);
  assert.match(inputSchema.checkDefinition({ fields: {}, context: ['business'], context_rules: { other: true } }), /may only set/);
  assert.match(inputSchema.checkDefinition({ fields: {}, context: ['business'], context_rules: { need_industry: 'yes' } }), /true or false/);
  assert.match(inputSchema.checkDefinition({ fields: {}, context_rules: { need_industry: true } }), /needs "business"/);
});

// ---------- F3 prompt renderer ----------

test('F3: placeholders, sections, reserved names; values are never expanded again', () => {
  const ctx = { language: { name: 'Tamil', native_name: 'தமிழ்' }, business: { industry: 'Bakery', city: 'Madurai' } };
  const tpl = 'For {{company_name}} ({{industry}}, {{location}}) in {{language}}.{{?tagline}} Tagline: "{{tagline}}".{{/tagline}}{{^tagline}} No tagline.{{/tagline}}';
  assert.equal(promptTemplate.render(tpl, { company_name: 'Sri Sweets', tagline: 'Pure ghee' }, ctx),
    'For Sri Sweets (Bakery, Madurai) in Tamil (தமிழ்). Tagline: "Pure ghee".');
  assert.equal(promptTemplate.render(tpl, { company_name: '{{industry}}' }, { ...ctx, location: 'Salem' }),
    'For {{industry}} (Bakery, Salem) in Tamil (தமிழ்). No tagline.', 'a value is inserted as text');
  assert.equal(promptTemplate.render('{{?auto}}A{{/auto}}{{^auto}}B{{/auto}}', { auto: false }), 'B', 'false counts as empty');
  assert.equal(promptTemplate.render('{{input_json}}', { a: 1, img: { base64: 'xx', mime: 'image/png' } }), '{\n  "a": 1\n}', 'images are not text');
  assert.deepEqual(promptTemplate.names(tpl).sort(), ['company_name', 'industry', 'language', 'location', 'tagline']);
  assert.equal(promptTemplate.checkSyntax(tpl), null);
  assert.match(promptTemplate.checkSyntax('{{?tagline}} open'), /unmatched/);
});

// ---------- F4 Magnific ----------

test('F4: Magnific prompt_template is the prompt, and num_images can be fixed on the route', () => {
  const spec = magnific.MODELS['gpt-image-2-5'];
  const fixed = { prompt_template: 'Logo for {{company_name}}, a {{industry}} business. Style: {{logo_style}}.', num_images: 2 };
  const body = magnific._buildBody(spec, { company_name: 'Kavya', logo_style: 'minimal' }, fixed, null, { business: { industry: 'Fashion' } });
  assert.equal(body.prompt, 'Logo for Kavya, a Fashion business. Style: minimal.');
  assert.equal(body.num_images, 2);
  assert.equal(magnific._buildBody(spec, { prompt: 'sale' }, {}).num_images, 1, 'no template, no fixed count: as before');

  assert.equal(magnific.validateRoute({ model: 'gpt-image-2-5', fixedParams: fixed }), null);
  assert.match(magnific.validateRoute({ model: 'gpt-image-2', fixedParams: { num_images: 2 } }), /num_images must be 1\.\.1/);
  assert.match(magnific.validateRoute({ model: 'remove-background', fixedParams: { prompt_template: 'x' } }), /no prompt_template/);
  assert.match(magnific.validateRoute({ model: 'gpt-image-2-5', fixedParams: { prompt_template: '{{?a}} x' } }), /unmatched/);

  const schema = {
    fields: { company_name: { type: 'string', required: true }, logo_style: { type: 'enum', values: ['minimal'], required: true } },
    context: ['business'],
  };
  assert.deepEqual(magnific.checkOperation({ model: 'gpt-image-2-5', fixedParams: fixed, inputSchema: schema }), [], 'no prompt field needed');
  assert.match(magnific.checkOperation({ model: 'gpt-image-2-5', fixedParams: fixed, inputSchema: { fields: schema.fields } }).join(), /declares no "context"/);
  assert.match(magnific.checkOperation({ model: 'gpt-image-2-5', fixedParams: fixed, inputSchema: { ...schema, fields: { ...schema.fields, colour: { type: 'string' } } } }).join(),
    /"colour" is never sent/);
  assert.match(magnific.checkOperation({ model: 'gpt-image-2-5', fixedParams: {}, inputSchema: schema }).join(), /needs a string field "prompt"/, 'without a template, as before');
});

// ---------- F5/F6/F8 Google ----------

// The image answer as the Interactions docs show it (2026-11-28): a thought step
// (interim image), then the model output with text and the final image.
const imageAnswer = (buf) => ({
  steps: [
    { type: 'user_input', content: [{ type: 'text', text: 'x' }] },
    { type: 'thought', summary: [{ type: 'image', data: Buffer.from('interim').toString('base64') }] },
    { type: 'model_output', content: [{ type: 'text', text: 'Here you go' }, { type: 'image', data: buf.toString('base64') }] },
  ],
  usage: { total_input_tokens: 300, total_output_tokens: 1120 },
});

test('F5: Google image routes — Interactions API body, last image out, refusals', () => {
  const fixed = { output: 'image', system_prompt: 'Keep the product.', user_template: 'Background: {{prompt}}', image_size: '2K', aspect_ratio_map: { '4:5': '4:5' }, ...RATES };
  assert.equal(google.validateRoute({ model: 'gemini-nano-banana-2.1', fixedParams: fixed }), null);
  const body = google._buildImageBody('gemini-nano-banana-2.1', { prompt: 'marble table', aspect_ratio: '4:5', product_image: { base64: 'QUJD', mime: 'image/png' } }, fixed);
  assert.deepEqual(body, {
    model: 'gemini-nano-banana-2.1',
    input: [
      { type: 'text', text: 'Keep the product.' },
      { type: 'text', text: 'Background: marble table' },
      { type: 'image', mime_type: 'image/png', data: 'QUJD' },
    ],
    response_format: { type: 'image', mime_type: 'image/png', aspect_ratio: '4:5', image_size: '2K' },
  });
  const plain = google._buildImageBody('m', { prompt: 'kite' }, { output: 'image', user_template: '{{prompt}}', image_mime: 'image/jpeg' }, { attachments: [{ mime: 'image/png', base64: 'VEg=' }] });
  assert.deepEqual(plain.input, [{ type: 'text', text: 'kite' }, { type: 'image', mime_type: 'image/png', data: 'VEg=' }], 'no system text; thumbnail as an image');
  assert.deepEqual(plain.response_format, { type: 'image', mime_type: 'image/jpeg' });

  const out = google._parseImages(imageAnswer(PNG_1PX), fixed);
  assert.equal(out.files.length, 1);
  assert.ok(out.files[0].buffer.equals(PNG_1PX), 'the final image, not the interim thought image');
  assert.ok(out.providerUnits > 0);
  const two = google._parseImages({ steps: [{ type: 'model_output', content: [{ type: 'image', data: 'Zmlyc3Q=' }, { type: 'image', data: PNG_1PX.toString('base64') }] }] }, fixed);
  assert.ok(two.files[0].buffer.equals(PNG_1PX), 'one image per request: the last one');
  assert.equal(two.files.length, 1);
  assert.ok(google._parseImages({ output_image: { data: PNG_1PX.toString('base64') } }, fixed).files[0].buffer.equals(PNG_1PX), 'SDK-style output_image tolerated');
  assert.throws(() => google._parseImages({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot draw that' }] }] }, fixed),
    (e) => e.code === 'TASK_FAILED' && /cannot draw/.test(e.detail));
  assert.throws(() => google._parseImages({ status: 'failed', finish_reason: 'IMAGE_SAFETY' }, fixed), (e) => e.code === 'MODERATION_BLOCKED');

  for (const k of ['output_schema', 'thinking', 'max_output_tokens', 'temperature', 'safety_settings']) {
    const v = { output_schema: { type: 'object' }, thinking: { level: 'minimal' }, max_output_tokens: 10, temperature: 1, safety_settings: [] }[k];
    assert.match(google.validateRoute({ model: 'gemini-nano-banana-2.1', fixedParams: { ...fixed, [k]: v } }), /image routes take no/, k);
  }
  assert.match(google.validateRoute({ model: 'gemini-nano-banana-2.1', fixedParams: { ...fixed, image_size: '2k' } }), /uppercase K/);
  assert.match(google.validateRoute({ model: 'gemini-nano-banana-2.1', fixedParams: { ...fixed, image_mime: 'image/gif' } }), /image_mime/);
  assert.match(google.validateRoute({ model: 'gemini-nano-banana-2.1', fixedParams: { ...fixed, voice: 'x' } }), /audio routes only/);
  assert.equal(google.validateRoute({ model: 'gemini-nano-banana-2.1', fixedParams: { ...fixed, api_revision: '2026-05-20' } }), null);
  assert.match(google.validateRoute({ model: 'gemini-nano-banana-2.1', fixedParams: { ...fixed, api_revision: 'latest' } }), /date like/);
});

// The speech answer as the Interactions docs show it (2026-11-28).
const speechAnswer = (wavOrPcm, extra = {}) => ({
  steps: [
    { type: 'user_input', content: [{ type: 'text', text: 'x' }] },
    { type: 'model_output', content: [{ type: 'audio', data: wavOrPcm.toString('base64'), ...extra }] },
  ],
  usage: { total_input_tokens: 20, total_output_tokens: 600 },
});

test('F5: Google audio routes — Interactions API body, transcript verbatim, style separate, WAV kept', () => {
  const fixed = { output: 'audio', style_template: '{{tone}} tone, {{pace}} pace', voice_map: { asha: 'Kore', ravi: 'Puck' }, ...RATES };
  assert.equal(google.validateRoute({ model: 'gemini-3.8-flash-lite-tts', fixedParams: fixed }), null);
  const body = google._buildSpeechBody('gemini-3.8-flash-lite-tts', { text: 'Fresh sweets today! <laugh>', tone: 'cheerful', pace: 'slow', voice: 'asha' }, fixed);
  assert.deepEqual(body, {
    model: 'gemini-3.8-flash-lite-tts',
    input: [{ type: 'user_input', content: [{ type: 'text', text: 'Fresh sweets today! <laugh>', annotations: [{ type: 'speech_metadata', style: 'cheerful tone, slow pace' }] }] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: 'Kore' }] },
  });
  assert.equal(google._buildSpeechBody('m', { text: 'hi', voice: 'zed' }, { output: 'audio' }).input[0].content[0].annotations, undefined, 'no style, no annotation');
  assert.throws(() => google._buildSpeechBody('m', { text: 'hi' }, { output: 'audio' }), /voice is required/);

  // Documented: a complete WAV comes back, and is stored as is.
  const wavIn = google._pcmToWav(Buffer.alloc(4800));   // 100 ms of 24 kHz mono 16-bit silence
  const out = google._parseAudio(speechAnswer(wavIn), fixed);
  assert.ok(out.files[0].buffer.equals(wavIn));
  assert.equal(resultStore.audioDurationMs(out.files[0].buffer, 'audio/wav'), 100);
  assert.equal(out.providerUnits, Math.round(((20 * 30 + 600 * 3000) / 1e6) * 1e4) / 1e4, 'cost from usage');
  // Headerless PCM (the streaming form) is wrapped.
  const pcm = google._parseAudio(speechAnswer(Buffer.alloc(4800), { mime_type: 'audio/l16;rate=24000' }), fixed).files[0].buffer;
  assert.equal(resultStore.sniff(pcm), 'audio/wav');
  assert.equal(pcm.length, 44 + 4800);
  assert.throws(() => google._parseAudio({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'no' }] }] }, fixed), /no audio/);
  assert.throws(() => google._parseAudio({ status: 'blocked by safety' }, fixed), (e) => e.code === 'MODERATION_BLOCKED');

  assert.match(google.validateRoute({ model: 'gemini-3.8-flash-lite-tts', fixedParams: { ...fixed, system_prompt: 'x' } }), /take no system_prompt/);
  assert.match(google.validateRoute({ model: 'gemini-3.8-flash-lite-tts', fixedParams: { ...fixed, thinking: { level: 'minimal' } } }), /take no thinking/);
  assert.match(google.validateRoute({ model: 'gemini-3.1-flash-lite', fixedParams: { system_prompt: 'x', style_template: 'x', output_schema: { type: 'object' }, max_output_tokens: 10, thinking: { level: 'minimal' }, ...RATES } }), /audio routes only/);
  const schema = { fields: { text: { type: 'string', required: true }, tone: { type: 'enum', values: ['cheerful'] }, pace: { type: 'enum', values: ['slow'] }, voice: { type: 'enum', values: ['asha', 'zara'] } } };
  assert.match(google.checkOperation({ fixedParams: fixed, inputSchema: schema }).join(), /voice zara has no entry/);
  assert.match(google.checkOperation({ fixedParams: fixed, inputSchema: { fields: { ...schema.fields, photo: { type: 'media' } } } }).join(), /audio routes take no images/);
  assert.match(google.checkOperation({ fixedParams: { output: 'audio', voice: 'Kore', ...RATES }, inputSchema: { fields: { text: { type: 'string' }, tone: { type: 'string' } } } }).join(),
    /"tone" is never sent — add \{\{tone\}\} to user_template \(spoken\) or style_template/);
});

test('F6/F8: json routes take uploaded images; hashtags checked for pattern, count and duplicates', () => {
  const schemaOut = {
    type: 'object', required: ['caption', 'hashtags'],
    properties: {
      caption: { type: 'string', maxLength: 250 },
      hashtags: { type: 'array', minItems: 5, maxItems: 5, uniqueItems: true, items: { type: 'string', pattern: '^#\\S+$' } },
    },
  };
  const fixed = { system_prompt: 'Write a caption.', user_template: 'Notes: {{instructions}}', output_schema: schemaOut, max_output_tokens: 1024, thinking: { level: 'minimal' }, ...RATES };
  assert.equal(google.validateRoute({ model: 'gemini-3.1-flash-lite', fixedParams: fixed }), null);
  assert.deepEqual(google.checkOperation({ fixedParams: fixed, inputSchema: { fields: { image: { type: 'media' }, instructions: { type: 'string' } } } }), [],
    'an uploaded image is sent as an image');
  const tags = (...t) => ({ caption: 'Fresh today', hashtags: t });
  const parse = (obj) => google._parseGenerate({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }] }, fixed);
  assert.equal(parse(tags('#a', '#b', '#c', '#d', '#e')).text.hashtags.length, 5);
  assert.throws(() => parse(tags('#a', '#b', '#c', '#d')), /fewer than 5/);
  assert.throws(() => parse(tags('#a', '#b', '#c', '#d', 'e')), /does not match/);
  assert.throws(() => parse(tags('#a', '#b', '#c', '#d', '#A')), /duplicate/);
  assert.match(google.validateRoute({ model: 'gemini-3.1-flash-lite', fixedParams: { ...fixed, output_schema: { type: 'object', properties: { a: { type: 'string', pattern: '(' } } } } }), /not a valid regular expression/);
});

// ---------- F7 result storage ----------

test('F7: transparency check and audio sniffing', () => {
  assert.equal(resultStore.hasAlpha(PNG_1PX, 'image/png'), true, 'RGBA');
  assert.equal(resultStore.hasAlpha(PNG_OPAQUE, 'image/png'), false, 'RGB, no tRNS');
  assert.equal(resultStore.hasAlpha(Buffer.from([0xff, 0xd8, 0xff, 0]), 'image/jpeg'), false);
  const webp = (chunk, flags = 0) => { const b = Buffer.alloc(30); b.write('RIFF', 0); b.write('WEBP', 8); b.write(chunk, 12); b[20] = flags; return b; };
  assert.equal(resultStore.hasAlpha(webp('VP8X', 0x10), 'image/webp'), true);
  assert.equal(resultStore.hasAlpha(webp('VP8X', 0), 'image/webp'), false);
  assert.equal(resultStore.hasAlpha(webp('VP8L'), 'image/webp'), true);
  assert.equal(resultStore.sniff(Buffer.from('ID3\u0004rest')), 'audio/mpeg');
  assert.equal(resultStore.sniff(webp('VP8 ')), 'image/webp', 'WEBP is still an image');
});

// ---------- end to end through the worker ----------

const PRODUCT_SCHEMA = {
  fields: { product_image: { type: 'media', required: true }, prompt: { type: 'string', required: true } },
  context: ['business'],
  context_rules: { need_industry: true },
};
const PRODUCT_FIXED = { output: 'image', system_prompt: 'Keep the product exactly.', user_template: 'Background: {{prompt}}. Industry: {{industry}}.', ...RATES };

test('F2: need_industry refuses before any charge; need_subject off lets a bare request through', async () => {
  const op = await mkOp(PRODUCT_SCHEMA, PRODUCT_FIXED);
  const u = await mkUser({ withIndustry: false });
  const upload = await mkUpload(u);
  const r = await submit(u, op.key, { product_image: upload.uid, prompt: 'marble' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.ok(JSON.stringify(r.body).includes('industry'));
  assert.equal(await used(u.id), 0);

  const bare = await mkOp({ fields: { prompt: { type: 'string', required: true } }, context: ['business'], context_rules: { need_subject: false } },
    { output: 'image', user_template: '{{prompt}}', ...RATES });
  const nobody = await mkUser({ business: false });
  const ok = await submit(nobody, bare.key, { prompt: 'a red kite' });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  await AiJob.destroy({ where: { user_id: nobody.id } });
});

test('F2: a typed location overrides the business city for that request', async () => {
  const op = await mkOp(
    { fields: { prompt: { type: 'string', required: true }, location: { type: 'string', max: 100 } }, context: ['business'] },
    { output: 'image', user_template: '{{prompt}} in {{location}}', ...RATES },
  );
  const u = await mkUser();
  const r = await submit(u, op.key, { prompt: 'shop front', location: 'Ooty' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const job = await AiJob.findOne({ where: { uid: r.body.data.uid } });
  assert.equal(job.context.location, 'Ooty');
  assert.equal(job.context.business.city, 'Coimbatore', 'the profile itself is untouched');
  await AiJob.destroy({ where: { user_id: u.id } });
});

test('F5/F6/F7: an uploaded product image goes to Google inline and the generated image lands in the media library', async () => {
  const op = await mkOp(PRODUCT_SCHEMA, PRODUCT_FIXED);
  const u = await mkUser();
  const upload = await mkUpload(u);
  reply = () => ({ status: 200, headers: {}, data: imageAnswer(PNG_1PX) });

  const r = await submit(u, op.key, { product_image: upload.uid, prompt: 'on a marble table' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await runWorker();

  const job = await AiJob.findOne({ where: { uid: r.body.data.uid } });
  assert.equal(job.status, 'done', `${job.error_code} ${job.error_message}`);
  const sent = calls.find((c) => /\/interactions$/.test(c.url)).data;
  assert.equal(sent.model, 'gemini-nano-banana-2.1');
  assert.deepEqual(sent.input[0], { type: 'text', text: 'Keep the product exactly.' });
  assert.equal(sent.input[1].text, `Background: on a marble table. Industry: ${industry.name}.`);
  assert.deepEqual(sent.input[2], { type: 'image', mime_type: 'image/png', data: PNG_1PX.toString('base64') });
  assert.ok(!JSON.stringify(job.input).includes('base64'), 'image bytes are never stored on the job');

  const got = await h.request('GET', `${P}/ai/jobs/${job.uid}`, { token: u.token });
  const file = got.body.data.result.files[0];
  assert.equal(file.mime, 'image/png');
  assert.equal(file.duration_ms, null);
  assert.equal(uploaded.length, 1);
});

test('F5/F7: a TTS job stores one WAV with its duration', async () => {
  const schema = { fields: { text: { type: 'string', required: true, max_words: 300 }, tone: { type: 'enum', values: ['cheerful'], default: 'cheerful' }, voice: { type: 'enum', values: ['asha'], required: true } } };
  const fixed = { output: 'audio', style_template: '{{tone}}', voice_map: { asha: 'Kore' }, ...RATES };
  const op = await mkOp(schema, fixed, 'gemini-3.8-flash-lite-tts');
  const u = await mkUser();
  reply = () => ({ status: 200, headers: {}, data: speechAnswer(google._pcmToWav(Buffer.alloc(48000))) });

  const r = await submit(u, op.key, { text: 'Fresh sweets today', voice: 'asha' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await runWorker();
  const call = calls.find((c) => /\/interactions$/.test(c.url));
  assert.ok(call, 'speech goes to the Interactions API');
  assert.equal(call.data.input[0].content[0].text, 'Fresh sweets today', 'spoken as written');
  assert.equal(call.data.input[0].content[0].annotations[0].style, 'cheerful');
  const got = await h.request('GET', `${P}/ai/jobs/${r.body.data.uid}`, { token: u.token });
  assert.equal(got.body.data.status, 'done', JSON.stringify(got.body.data.error));
  const file = got.body.data.result.files[0];
  assert.equal(file.mime, 'audio/wav');
  assert.equal(file.duration_ms, 1000);
  assert.match(uploaded[0], /\/1\.wav$/);
});

test('F6 / phase 2: an upload over the inline limit is a 400 at submit, nothing charged', async () => {
  const op = await mkOp(PRODUCT_SCHEMA, PRODUCT_FIXED);
  const u = await mkUser();
  const big = await UserUpload.create({ user_id: u.id, s3_key: `users/${u.uid}/media/${uuid()}.png`, slot: 'media_library', bytes: 8 * 1024 * 1024, content_type: 'image/png' });
  const r = await submit(u, op.key, { product_image: big.uid, prompt: 'marble' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.ok(JSON.stringify(r.body).includes('at most 7 MB'));
  assert.equal(await used(u.id), 0);
});

test('F6: bytes that are not an image (whatever the stored type says) fail at send as INVALID_INPUT and are refunded', async () => {
  const op = await mkOp(PRODUCT_SCHEMA, PRODUCT_FIXED);
  const u = await mkUser();
  const upload = await mkUpload(u);
  s3.getObjectBuffer = async () => Buffer.from('%PDF-1.7 not an image');
  try {
    const r = await submit(u, op.key, { product_image: upload.uid, prompt: 'marble' });
    assert.equal(r.status, 202);
    await runWorker();
    const job = await AiJob.findOne({ where: { uid: r.body.data.uid } });
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'INVALID_INPUT');
    assert.ok(job.refunded_at, 'credits back');
    assert.equal(calls.filter((c) => /interactions|generateContent/.test(c.url)).length, 0, 'nothing was sent');
  } finally {
    s3.getObjectBuffer = async () => PNG_1PX;
  }
});

// ---------- phase 2: background removal ----------

test('phase 2: a remove-background result must be transparent', async () => {
  reply = () => ({ status: 200, headers: {}, data: { url: 'https://cdn-magnific.freepik.com/out.png', high_resolution: 'https://cdn-magnific.freepik.com/out.png' } });
  const out = await magnific.submit({
    input: { image: { url: 'https://cdn.example.invalid/in.png', bytes: 10 } },
    route: { model: 'remove-background', fixed_params: { body_encoding: 'form' } },
    provider: { base_url: null, timeout_ms: 1000 }, apiKey: 'k',
  });
  assert.deepEqual(out.files, [{ url: 'https://cdn-magnific.freepik.com/out.png', require_alpha: true }]);

  const u = await mkUser({ business: false });
  const job = { uid: uuid(), user_id: u.id, operation_key: 'bg_remove' };
  await assert.rejects(resultStore.store(job, [{ buffer: PNG_OPAQUE, require_alpha: true }], magnific),
    (e) => e.code === 'TASK_FAILED' && /no transparent background/.test(e.detail));
  assert.equal(uploaded.length, 0, 'an opaque result is never stored');
  const stored = await resultStore.store(job, [{ buffer: PNG_1PX, require_alpha: true }], magnific);
  assert.equal(stored[0].mime, 'image/png');
  const opaqueOk = await resultStore.store({ ...job, uid: uuid() }, [{ buffer: PNG_OPAQUE }], magnific);
  assert.equal(opaqueOk.length, 1, 'other results are not checked');
});

test('phase 2: remove-background takes PNG, JPEG or WEBP up to 20 MB — refused before any charge', () => {
  const bg = [{ route: { model: 'remove-background' }, adapter: magnific }];
  const img = (content_type, bytes = 1000) => [{ field: 'image', uid: uuid(), content_type, bytes }];
  const jobs = require('../src/services/aiJob.service');
  for (const t of ['image/png', 'image/jpeg', 'image/webp']) assert.doesNotThrow(() => jobs.assertMediaFits(img(t), bg));
  assert.throws(() => jobs.assertMediaFits(img('image/gif'), bg), (e) => e.details[0].field === 'image' && /PNG, JPEG or WEBP/.test(e.details[0].message));
  assert.throws(() => jobs.assertMediaFits(img('image/png', 21 * 1024 * 1024), bg), (e) => /at most 20 MB/.test(e.details[0].message));
  // A job that may go to either route must fit both; a GIF is fine for a text-to-image model.
  assert.doesNotThrow(() => jobs.assertMediaFits(img('image/gif'), [{ route: { model: 'nano-banana-2-1' }, adapter: magnific }]));
  assert.doesNotThrow(() => jobs.assertMediaFits(img('image/gif'), [{ route: { model: 'x' }, adapter: {} }]), 'an adapter without limits checks nothing');
});

// ---------- phase 3: logo generation ----------

const m068 = require('../src/db/migrations/20260101000068-ai-logo-generation');

test('phase 3: nested template sections resolve outside-in', () => {
  const tpl = '{{^tagline}}{{?auto_tagline}}AUTO{{/auto_tagline}}{{^auto_tagline}}NONE{{/auto_tagline}}{{/tagline}}{{?tagline}}GIVEN{{/tagline}}';
  assert.equal(promptTemplate.render(tpl, { auto_tagline: true }), 'AUTO');
  assert.equal(promptTemplate.render(tpl, { auto_tagline: false }), 'NONE');
  assert.equal(promptTemplate.render(tpl, { tagline: 'x', auto_tagline: false }), 'GIVEN');
  assert.ok(promptTemplate.names(tpl).includes('auto_tagline'), 'nested section names are found');
  assert.equal(promptTemplate.checkSyntax(tpl), null);
  assert.match(promptTemplate.checkSyntax('{{^tagline}}{{?auto_tagline}}x{{/tagline}}'), /unmatched/);
});

test('phase 3: migration 068 seeds logo.generate inactive, with a valid gpt-image-2-5 route making 2 logos', async () => {
  assert.equal(inputSchema.checkDefinition(m068.INPUT_SCHEMA), null);
  assert.equal(magnific.validateRoute({ model: m068.MODEL, fixedParams: m068.FIXED_PARAMS }), null);
  assert.deepEqual(magnific.checkOperation({ model: m068.MODEL, fixedParams: m068.FIXED_PARAMS, inputSchema: m068.INPUT_SCHEMA }), []);

  const op = await AiOperation.findOne({ where: { key: 'logo.generate' } });
  assert.ok(op, 'seeded');
  assert.equal(Boolean(op.is_active), false, 'ships inactive (price undecided)');
  assert.equal(op.ledger_source, 'logo_generation');
  assert.equal(op.unit, 'image');
  assert.deepEqual(op.input_schema.context_rules, { need_subject: false, need_industry: true });
  const routes = await AiOperationRoute.findAll({ where: { operation_id: op.id } });
  const mag = await AiProvider.findOne({ where: { key: 'magnific' } });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].provider_id, mag.id);
  assert.equal(routes[0].model, 'gpt-image-2-5');
  assert.equal(routes[0].fixed_params.num_images, 2, 'two options in one request');
});

test('phase 3: the logo prompt follows the tagline rule and the request asks for 2 images', () => {
  const ctx = { business: { industry: 'Bakery' } };
  const input = (over) => inputSchema.validateInput(m068.INPUT_SCHEMA, {
    company_name: 'Sri Sweets', logo_type: 'wordmark with icon', logo_style: 'modern minimal', colour_preference: 'maroon and gold', ...over,
  });
  const body = (over) => magnific._buildBody(magnific.MODELS[m068.MODEL], input(over), m068.FIXED_PARAMS, 'https://api.example/cb', ctx);

  const given = body({ tagline: 'Pure ghee since 1985' });
  assert.equal(given.num_images, 2);
  assert.equal(given.quality, 'medium');
  assert.match(given.prompt, /logo for "Sri Sweets", a Bakery business/);
  assert.match(given.prompt, /Logo type: wordmark with icon\. Style: modern minimal\. Colours: maroon and gold\./);
  assert.match(given.prompt, /tagline exactly as written: "Pure ghee since 1985"/);
  assert.doesNotMatch(given.prompt, /\{\{|\}\}/, 'no template syntax left');

  const auto = body({});
  assert.match(auto.prompt, /Add a short, memorable tagline that suits a Bakery business/, 'auto_tagline defaults to true');
  assert.doesNotMatch(auto.prompt, /exactly as written/);

  const none = body({ auto_tagline: false });
  assert.match(none.prompt, /Do not add a tagline/);
  assert.doesNotMatch(none.prompt, /memorable tagline/);

  assert.throws(() => input({ company_name: '' }), /Validation failed/);
  assert.throws(() => input({ logo_style: undefined }), /Validation failed/);
});

// ---------- phase 4: image generation + product background ----------

const m069 = require('../src/db/migrations/20260101000069-ai-image-and-product-background');

test('phase 4: migration 069 seeds image.generate and image.product_background, inactive, on valid Nano Banana 2.1 routes', async () => {
  const gRow = await AiProvider.findOne({ where: { key: 'google' } });
  for (const def of m069.OPERATIONS) {
    assert.equal(inputSchema.checkDefinition(def.input_schema), null, def.key);
    assert.equal(google.validateRoute({ model: m069.MODEL, fixedParams: def.fixed_params }), null, def.key);
    assert.deepEqual(google.checkOperation({ model: m069.MODEL, fixedParams: def.fixed_params, inputSchema: def.input_schema }), [], def.key);

    const op = await AiOperation.findOne({ where: { key: def.key } });
    assert.ok(op, `${def.key} seeded`);
    assert.equal(Boolean(op.is_active), false, `${def.key} ships inactive`);
    assert.equal(op.unit, 'image');
    assert.equal(op.ledger_source, def.ledger);
    const routes = await AiOperationRoute.findAll({ where: { operation_id: op.id } });
    assert.equal(routes.length, 1);
    assert.equal(routes[0].provider_id, gRow.id);
    assert.equal(routes[0].model, 'gemini-nano-banana-2.1');
    assert.equal(routes[0].fixed_params.output, 'image');
  }
  const pb = await AiOperation.findOne({ where: { key: 'image.product_background' } });
  const pbRoute = await AiOperationRoute.findOne({ where: { operation_id: pb.id } });
  assert.equal(Boolean(pbRoute.fallback_allowed), false, 'the product job never moves to another route');
  assert.ok(await AiOperation.findOne({ where: { key: 'image.standard' } }), 'the Magnific image operations are untouched');
});

test('phase 4: image.generate — prompt as written, industry only as soft context, fashion-friendly rules first', () => {
  const def = m069.IMAGE_GENERATE;
  const input = inputSchema.validateInput(def.input_schema, { prompt: 'A model in a sleeveless red dress on a beach at sunset', aspect_ratio: '4:5' });
  const body = google._buildImageBody(m069.MODEL, input, def.fixed_params, { context: { business: { industry: 'Fashion' } } });
  assert.match(body.input[0].text, /normal fashion photography/);
  assert.match(body.input[0].text, /Never create: nudity/);
  assert.equal(body.input[1].text, 'A model in a sleeveless red dress on a beach at sunset\n\n(For context only, if it fits the description: the image is for a Fashion business.)');
  assert.deepEqual(body.response_format, { type: 'image', mime_type: 'image/png', aspect_ratio: '4:5', image_size: '1K' });
  assert.equal(body.input.length, 2, 'no image input');

  const noBiz = google._buildImageBody(m069.MODEL, inputSchema.validateInput(def.input_schema, { prompt: 'A red kite' }), def.fixed_params, { context: { business: null } });
  assert.equal(noBiz.input[1].text, 'A red kite', 'industry is optional');
  assert.equal(noBiz.response_format.aspect_ratio, '1:1', 'default ratio');
  assert.throws(() => inputSchema.validateInput(def.input_schema, { prompt: 'x' }), /Validation failed/, 'prompt of at least 3 characters');
  assert.throws(() => inputSchema.validateInput(def.input_schema, { prompt: 'a kite', aspect_ratio: '3:2' }), /Validation failed/);
});

test('phase 4: image.product_background — the product image goes after the preservation rules and the request', () => {
  const def = m069.PRODUCT_BACKGROUND;
  const input = inputSchema.validateInput(def.input_schema, { product_image: uuid(), prompt: 'on a marble kitchen counter', product_category: 'cookware' });
  input.product_image = { base64: 'QUJD', mime: 'image/png' };   // as the worker resolves it
  const body = google._buildImageBody(m069.MODEL, input, def.fixed_params, { context: { business: { industry: 'Home & Kitchen' } } });
  assert.match(body.input[0].text, /Keep it exactly as it is: the same shape, colours, texture/);
  assert.equal(body.input[1].text, 'Background to create: on a marble kitchen counter\nBusiness: a Home & Kitchen business.\nProduct category: cookware.');
  assert.deepEqual(body.input[2], { type: 'image', mime_type: 'image/png', data: 'QUJD' });
  const noCat = google._buildImageBody(m069.MODEL, { ...input, product_category: undefined }, def.fixed_params, { context: { business: { industry: 'Bakery' } } });
  assert.equal(noCat.input[1].text, 'Background to create: on a marble kitchen counter\nBusiness: a Bakery business.');
  assert.throws(() => inputSchema.validateInput(def.input_schema, { prompt: 'on a table' }), /Validation failed/, 'product image required');
  assert.throws(() => inputSchema.validateInput(def.input_schema, { product_image: uuid() }), /Validation failed/, 'background prompt required');
});

// ---------- phase 5: caption generation ----------

const m070 = require('../src/db/migrations/20260101000070-ai-caption-generation');
const captionAnswer = (obj) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 120, thoughtsTokenCount: 0 },
});
const GOOD_CAPTION = {
  caption: 'புதிய இனிப்புகள் இன்று தயார்!\nநெய் மணம் நிறைந்த சுவை உங்களுக்காக.',
  hashtags: ['#இனிப்பு', '#Madurai', '#SweetShop', '#Diwali', '#FreshSweets'],
};

test('phase 5: migration 070 seeds text.caption inactive on a valid Gemini 3.1 Flash-Lite route; the platform captions stay', async () => {
  assert.equal(inputSchema.checkDefinition(m070.INPUT_SCHEMA), null);
  assert.equal(google.validateRoute({ model: m070.MODEL, fixedParams: m070.FIXED_PARAMS }), null);
  assert.deepEqual(google.checkOperation({ model: m070.MODEL, fixedParams: m070.FIXED_PARAMS, inputSchema: m070.INPUT_SCHEMA }), []);
  const op = await AiOperation.findOne({ where: { key: 'text.caption' } });
  assert.ok(op);
  assert.equal(Boolean(op.is_active), false);
  assert.equal(op.unit, 'text');
  assert.equal(op.ledger_source, 'text_generation');
  const routes = await AiOperationRoute.findAll({ where: { operation_id: op.id } });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].model, 'gemini-3.1-flash-lite');
  assert.equal(await AiOperation.count({ where: { key: ['text.post.instagram', 'text.post.facebook', 'text.post.linkedin', 'text.post.whatsapp', 'text.post.youtube'] } }), 5);
});

test('phase 5: exactly one of image or project; language en, ta or hi', () => {
  const s = m070.INPUT_SCHEMA;
  assert.ok(inputSchema.validateInput(s, { image: uuid(), language: 'ta' }));
  assert.ok(inputSchema.validateInput(s, { project: uuid(), language: 'hi' }));
  assert.throws(() => inputSchema.validateInput(s, { language: 'en' }), (e) => e.details[0].field === 'image|project');
  assert.throws(() => inputSchema.validateInput(s, { image: uuid(), project: uuid(), language: 'en' }), /Validation failed/);
  assert.throws(() => inputSchema.validateInput(s, { image: uuid() }), /Validation failed/, 'language is required');
  assert.throws(() => inputSchema.validateInput(s, { image: uuid(), language: 'te' }), /Validation failed/, 'only the three launch languages');
});

test('phase 5: the caption answer is checked — 250 characters, exactly 5 unique # hashtags', () => {
  const parse = (obj) => google._parseGenerate(captionAnswer(obj), m070.FIXED_PARAMS);
  assert.deepEqual(parse(GOOD_CAPTION).text, GOOD_CAPTION);
  assert.throws(() => parse({ ...GOOD_CAPTION, caption: 'x'.repeat(251) }), /longer than 250/);
  assert.throws(() => parse({ ...GOOD_CAPTION, hashtags: GOOD_CAPTION.hashtags.slice(0, 4) }), /fewer than 5/);
  assert.throws(() => parse({ ...GOOD_CAPTION, hashtags: [...GOOD_CAPTION.hashtags.slice(0, 4), 'Diwali'] }), /does not match/);
  assert.throws(() => parse({ ...GOOD_CAPTION, hashtags: [...GOOD_CAPTION.hashtags.slice(0, 4), '#two words'] }), /does not match/);
  assert.throws(() => parse({ ...GOOD_CAPTION, hashtags: [...GOOD_CAPTION.hashtags.slice(0, 4), '#diwali'] }), /duplicate/);

  const sent = google._sendableSchema(m070.OUTPUT_SCHEMA);
  assert.equal(sent.properties.hashtags.uniqueItems, undefined, 'checked here, not sent');
  assert.equal(sent.properties.hashtags.items.pattern, undefined);
  assert.equal(sent.properties.hashtags.minItems, 5);
  assert.equal(m070.OUTPUT_SCHEMA.properties.hashtags.uniqueItems, true, 'the route keeps the full schema');
});

test('phase 5: an uploaded post image goes to Gemini with the language, industry and typed location; the caption comes back as text', async () => {
  const op = await mkOp(m070.INPUT_SCHEMA, m070.FIXED_PARAMS, m070.MODEL);
  const u = await mkUser();
  const upload = await mkUpload(u);
  reply = () => ({ status: 200, headers: {}, data: captionAnswer(GOOD_CAPTION) });

  const none = await submit(u, op.key, { language: 'ta' });
  assert.equal(none.status, 400, 'no image and no project');
  assert.equal(await used(u.id), 0);

  const r = await submit(u, op.key, { image: upload.uid, language: 'ta', location: 'Madurai', instructions: 'Diwali special box' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await runWorker();
  const got = await h.request('GET', `${P}/ai/jobs/${r.body.data.uid}`, { token: u.token });
  assert.equal(got.body.data.status, 'done', JSON.stringify(got.body.data.error));
  assert.deepEqual(got.body.data.result.text, GOOD_CAPTION);
  assert.deepEqual(got.body.data.result.files, []);

  const sent = calls.find((c) => /:generateContent$/.test(c.url)).data;
  assert.equal(sent.contents[0].parts[0].inlineData.mimeType, 'image/png', 'the post image goes first');
  const text = sent.contents[0].parts[1].text;
  assert.match(text, /Write the caption in: Tamil \(தமிழ்\)/);
  assert.ok(text.includes(`Industry: ${industry.name}`), text);
  assert.match(text, /Location: Madurai/);
  assert.match(text, /<<<\nDiwali special box\n>>>/);
  assert.equal(sent.generationConfig.responseJsonSchema.properties.hashtags.uniqueItems, undefined);
  assert.match(sent.systemInstruction.parts[0].text, /EXACTLY 5 hashtags/);
});

// ---------- phase 6: text-to-voice ----------

const m071 = require('../src/db/migrations/20260101000071-ai-text-to-voice');

test('phase 6: migration 071 seeds voice.tts inactive on a valid Gemini 3.8 Flash-Lite TTS route with 30 voices', async () => {
  assert.equal(inputSchema.checkDefinition(m071.INPUT_SCHEMA), null);
  assert.equal(google.validateRoute({ model: m071.MODEL, fixedParams: m071.FIXED_PARAMS }), null);
  assert.deepEqual(google.checkOperation({ model: m071.MODEL, fixedParams: m071.FIXED_PARAMS, inputSchema: m071.INPUT_SCHEMA }), []);
  assert.equal(m071.VOICE_OPTIONS.length, 30);
  for (const v of m071.VOICE_OPTIONS) {
    assert.deepEqual(v.gender, ['female', 'male'], `${v.label}: gender is a placeholder`);
    assert.equal(v.gender_verified, false);
    assert.deepEqual(v.languages, ['en', 'ta', 'hi']);
    assert.equal(m071.FIXED_PARAMS.voice_map[v.value], v.label, 'our value maps to the Google voice name');
  }
  const op = await AiOperation.findOne({ where: { key: 'voice.tts' } });
  assert.ok(op);
  assert.equal(Boolean(op.is_active), false);
  assert.equal(op.unit, 'audio');
  assert.equal(op.ledger_source, 'text_to_audio');
  const routes = await AiOperationRoute.findAll({ where: { operation_id: op.id } });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].model, 'gemini-3.8-flash-lite-tts');
  assert.equal(routes[0].fixed_params.output, 'audio');
});

test('phase 6: inputs — 300 words, the 8 tones, pace defaults to normal, voice must fit gender and language', () => {
  const s = m071.INPUT_SCHEMA;
  const base = { text: 'Fresh sweets today', language: 'ta', voice_gender: 'female', voice: 'kore', tone: 'cheerful' };
  assert.equal(inputSchema.validateInput(s, base).pace, 'normal');
  assert.equal(inputSchema.validateInput(s, { ...base, voice_gender: 'male' }).voice, 'kore', 'untagged voices are offered under both genders');
  assert.deepEqual(inputSchema.enumValues(s.fields.tone), ['natural', 'humorous', 'cheerful', 'professional', 'emotional', 'calm', 'energetic', 'storytelling']);
  assert.throws(() => inputSchema.validateInput(s, { ...base, text: Array(301).fill('வணக்கம்').join(' ') }), (e) => /at most 300 words/.test(e.details[0].message));
  assert.ok(inputSchema.validateInput(s, { ...base, text: Array(300).fill('வணக்கம்').join(' ') }), '300 Tamil words fit');
  assert.throws(() => inputSchema.validateInput(s, { ...base, tone: 'angry' }), /Validation failed/);
  assert.throws(() => inputSchema.validateInput(s, { ...base, language: 'te' }), /Validation failed/);

  // Once the team tags a voice, the same schema rejects the other gender.
  const tagged = JSON.parse(JSON.stringify(s));
  tagged.fields.voice.options.find((o) => o.value === 'kore').gender = 'female';
  assert.throws(() => inputSchema.validateInput(tagged, { ...base, voice_gender: 'male' }), (e) => e.details[0].field === 'voice');
});

test('phase 6: the text is spoken as written; tone and pace go in the style', () => {
  const input = inputSchema.validateInput(m071.INPUT_SCHEMA, { text: 'புதிய இனிப்புகள் இன்று தயார்!', language: 'ta', voice_gender: 'male', voice: 'puck', tone: 'storytelling', pace: 'slow' });
  const body = google._buildSpeechBody(m071.MODEL, input, m071.FIXED_PARAMS);
  assert.equal(body.input[0].content[0].text, 'புதிய இனிப்புகள் இன்று தயார்!');
  assert.deepEqual(body.input[0].content[0].annotations, [{ type: 'speech_metadata', style: 'Speak in a storytelling tone, at a slow pace.' }]);
  assert.deepEqual(body.generation_config, { speech_config: [{ voice: 'Puck' }] });
});
