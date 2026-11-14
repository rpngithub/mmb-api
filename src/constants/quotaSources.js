// What a quota spend is ATTRIBUTED to — the "breakdown by tool" rows on the Usage
// screen ("Image Generation 120, Background Removal 40").
//
// Held in code rather than as a `quota_usage_events.source` enum or a lookup table
// because these are product surfaces, not user data: a new AI tool ships with its
// own release and should not need a migration or an admin seeding step to appear
// in the breakdown. The column is a plain VARCHAR, so an unrecognised source still
// records — it just falls back to a generic label when displayed.
//
// `feature` is the quota key the source is allowed to spend. quota.service asserts
// the two agree, so a miswired call site ("background_removal" charged against
// downloads) fails loudly instead of quietly producing a nonsense breakdown.
const SOURCES = {
  // ai_credits — spent by AI jobs (services/aiJob.service.js). Each AI operation
  // names its source in ai_operations.ledger_source, which the admin validates
  // against this list; a refunded job writes a negative row under the same source.
  image_generation:   { label: 'Image Generation',   feature: 'ai_credits' },
  background_removal: { label: 'Background Removal', feature: 'ai_credits' },
  logo_generation:    { label: 'Logo Generation',    feature: 'ai_credits' },
  text_to_audio:      { label: 'Text to Audio',      feature: 'ai_credits' },
  image_edit:         { label: 'Image Editing',      feature: 'ai_credits' },
  upscale:            { label: 'Upscale',            feature: 'ai_credits' },
  expand:             { label: 'Expand Image',       feature: 'ai_credits' },
  relight:            { label: 'Relight',            feature: 'ai_credits' },
  style_transfer:     { label: 'Style Transfer',     feature: 'ai_credits' },
  icon_generation:    { label: 'Icon Generation',    feature: 'ai_credits' },
  prompt_assist:      { label: 'Prompt Assist',      feature: 'ai_credits' },
  // Social post titles / captions / hashtags (text operations, unit 'text').
  text_generation:    { label: 'Caption Writing',    feature: 'ai_credits' },

  // Already metered today.
  download:           { label: 'Downloads',          feature: 'downloads' },
  share:              { label: 'Shares',             feature: 'shares' },
  upload:             { label: 'Uploads',            feature: 'storage' },
  // An AI result copied into the user's media library takes space like an upload.
  ai_result:          { label: 'AI Results',         feature: 'storage' },

  // Holdings — see constants/quotaMeters.js. One source per meter because a
  // source belongs to exactly one feature.
  business_post_project: { label: 'Projects from templates', feature: 'business_posts_templates' },
  video_project:         { label: 'Projects from templates', feature: 'video_templates' },
  brand_series_add:      { label: 'Brand series variant added', feature: 'brand_series' },
  frame_add:             { label: 'Frames added',            feature: 'frames' },
};

// The source a template project is attributed to, by meter.
const PROJECT_SOURCE = {
  business_posts_templates: 'business_post_project',
  video_templates:          'video_project',
};

const FALLBACK = 'other';

// The label to show for a recorded source, including ones this build no longer
// knows about — an event written by an older or newer release must still render.
const labelFor = (source) => SOURCES[source]?.label || 'Other';

const isKnown = (source) => Object.prototype.hasOwnProperty.call(SOURCES, source);

module.exports = { SOURCES, PROJECT_SOURCE, FALLBACK, labelFor, isKnown };
