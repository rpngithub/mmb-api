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
  // ai_credits — nothing spends these yet. The meter, the balance and the ledger
  // are here; whoever builds the first AI endpoint calls
  //   quota.consume(userId, 'ai_credits', n, { source: 'image_generation' })
  // and its row appears in the breakdown with no further wiring.
  image_generation:   { label: 'Image Generation',   feature: 'ai_credits' },
  background_removal: { label: 'Background Removal', feature: 'ai_credits' },
  logo_generation:    { label: 'Logo Generation',    feature: 'ai_credits' },
  text_to_audio:      { label: 'Text to Audio',      feature: 'ai_credits' },

  // Already metered today.
  download:           { label: 'Downloads',          feature: 'downloads' },
  share:              { label: 'Shares',             feature: 'shares' },
  upload:             { label: 'Uploads',            feature: 'storage' },
};

const FALLBACK = 'other';

// The label to show for a recorded source, including ones this build no longer
// knows about — an event written by an older or newer release must still render.
const labelFor = (source) => SOURCES[source]?.label || 'Other';

const isKnown = (source) => Object.prototype.hasOwnProperty.call(SOURCES, source);

module.exports = { SOURCES, FALLBACK, labelFor, isKnown };
