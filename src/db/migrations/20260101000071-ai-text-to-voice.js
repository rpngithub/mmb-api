'use strict';

const { v4: uuid } = require('uuid');

/**
 * AI Dev Kit, feature 05 — text-to-voice (`voice.tts`), on Google's Gemini 3.8
 * Flash-Lite TTS (`gemini-3.8-flash-lite-tts`, Interactions API; see
 * src/ai/providers/google.js and aistudio.google.com/docs/speech-generation).
 *
 *   The app sends: text (≤ 300 words, spoken exactly as written), language
 *                  (en | ta | hi), voice_gender (male | female), voice (from the
 *                  list below), tone (8 options), pace (slow | normal | fast,
 *                  default normal).
 *   The server checks: the word count, and that the voice fits the language and
 *                  gender (input_schema `match`), before any charge.
 *   Google gets: the text as the transcript, unchanged; tone + pace as the
 *                  speaking style; the voice. Language is detected from the text.
 *   Result:        one WAV file (24 kHz, mono) with duration_ms.
 *
 * VOICES — the 30 prebuilt Gemini TTS voices, with Google's own style words. Every
 * voice speaks every language Google supports (English, Tamil and Hindi included).
 * GENDER IS A PLACEHOLDER: Google does not document it, so every voice is listed as
 * ["female", "male"] (offered under both choices) with `gender_verified: false`
 * until the team tags each one by listening — then edit the operation's
 * input_schema in the admin panel (gender: "female" or "male", gender_verified:
 * true). No code change or migration is needed for that.
 *
 * Seeded INACTIVE at a placeholder 1 credit; token rates PLACEHOLDERS (TTS pricing
 * not yet looked up). INSERT IGNORE / existence checks: a re-run never overwrites
 * an admin's changes.
 */

const KEY = 'voice.tts';
const MODEL = 'gemini-3.8-flash-lite-tts';
const RATES = { input_cents_per_mtok: 50, output_cents_per_mtok: 1000 };   // PLACEHOLDER
const PROVIDER_UNITS = 1;                                                    // PLACEHOLDER, US cents per call

// [Google voice name, Google's style word]
const GOOGLE_VOICES = [
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm'],
  ['Fenrir', 'Excitable'], ['Leda', 'Youthful'], ['Orus', 'Firm'], ['Aoede', 'Breezy'],
  ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'], ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'],
  ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'], ['Erinome', 'Clear'],
  ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'], ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'],
  ['Alnilam', 'Firm'], ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'],
  ['Achird', 'Friendly'], ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'],
  ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
];
const LANGUAGES = ['en', 'ta', 'hi'];

const VOICE_OPTIONS = GOOGLE_VOICES.map(([name, style]) => ({
  value: name.toLowerCase(),
  label: name,
  style,
  gender: ['female', 'male'],   // PLACEHOLDER until the team tags it
  gender_verified: false,
  languages: LANGUAGES,
}));
const VOICE_MAP = Object.fromEntries(GOOGLE_VOICES.map(([name]) => [name.toLowerCase(), name]));

// The tone and pace VALUES are plain words, because they go into the speaking
// style as they are ("Speak in a cheerful tone, at a slow pace.").
const TONES = [
  { value: 'natural', label: 'Normal / Natural' },
  { value: 'humorous', label: 'Funny / Humorous' },
  { value: 'cheerful', label: 'Happy / Cheerful' },
  { value: 'professional', label: 'Professional' },
  { value: 'emotional', label: 'Emotional' },
  { value: 'calm', label: 'Calm / Relaxed' },
  { value: 'energetic', label: 'Energetic' },
  { value: 'storytelling', label: 'Storytelling' },
];
const PACES = [
  { value: 'slow', label: 'Slow' },
  { value: 'normal', label: 'Normal' },
  { value: 'fast', label: 'Fast' },
];

const INPUT_SCHEMA = {
  fields: {
    // 300 words of Tamil or Hindi can run past 2,000 characters; the word limit is the rule.
    text:         { type: 'string', required: true, min: 1, max: 5000, max_words: 300 },
    language:     { type: 'enum', values: LANGUAGES, required: true },
    voice_gender: { type: 'enum', options: [{ value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }], required: true },
    voice:        { type: 'enum', options: VOICE_OPTIONS, required: true, match: { gender: 'voice_gender', languages: 'language' } },
    tone:         { type: 'enum', options: TONES, required: true },
    pace:         { type: 'enum', options: PACES, default: 'normal' },
  },
  // Declared for the language: the server resolves and records it on the job.
  context: ['business'],
  context_rules: { need_subject: false },
};

// The transcript is the text alone (every word is spoken); the style carries tone and pace.
const FIXED_PARAMS = {
  output: 'audio',
  prompt_version: 'tts-v1',
  user_template: '{{text}}',
  style_template: 'Speak in a {{tone}} tone, at a {{pace}} pace.',
  voice_map: VOICE_MAP,
  ...RATES,
};

module.exports = {
  KEY, MODEL, INPUT_SCHEMA, FIXED_PARAMS, VOICE_OPTIONS, VOICE_MAP, TONES, PACES, GOOGLE_VOICES,

  async up(queryInterface) {
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);
    await q(
      'INSERT IGNORE INTO ai_operations (uid, `key`, label, description, credits, unit, ledger_source, input_schema, price_rules, is_active, sort_order) ' +
      "VALUES (?, ?, 'AI voice', ?, 1, 'audio', 'text_to_audio', ?, ?, 0, 300)",
      { replacements: [uuid(), KEY, 'Your text read aloud in a natural voice, in English, Tamil or Hindi.', JSON.stringify(INPUT_SCHEMA), JSON.stringify({})] },
    );
    const [[op]] = await q('SELECT id FROM ai_operations WHERE `key` = ?', { replacements: [KEY] });
    const [[google]] = await q("SELECT id FROM ai_providers WHERE `key` = 'google'");
    if (!op || !google) {
      if (!google) console.warn('[migration 071] no google provider — voice.tts has no route. Add one in the admin panel.');
      return;
    }
    const [[has]] = await q('SELECT COUNT(*) AS n FROM ai_operation_routes WHERE operation_id = ? AND provider_id = ?', { replacements: [op.id, google.id] });
    if (Number(has.n)) return;
    await q(
      'INSERT INTO ai_operation_routes (uid, operation_id, provider_id, model, fixed_params, provider_units, priority, weight, fallback_allowed, is_active) ' +
      'VALUES (?, ?, ?, ?, ?, ?, 100, 100, 1, 1)',
      { replacements: [uuid(), op.id, google.id, MODEL, JSON.stringify(FIXED_PARAMS), PROVIDER_UNITS] },
    );
  },

  async down(queryInterface) {
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);
    await q(
      'DELETE r FROM ai_operation_routes r JOIN ai_operations o ON o.id = r.operation_id ' +
      'WHERE o.`key` = ? AND o.id NOT IN (SELECT operation_id FROM ai_jobs)',
      { replacements: [KEY] },
    );
    await q(
      'DELETE FROM ai_operations WHERE `key` = ? AND id NOT IN (SELECT operation_id FROM ai_jobs) ' +
      'AND id NOT IN (SELECT operation_id FROM ai_operation_routes)',
      { replacements: [KEY] },
    );
  },
};
