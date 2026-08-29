// Which quota features have enforcement SUSPENDED.
//
// `QUOTA_RELAXED_FEATURES` is a comma-separated list of feature_types keys, e.g.
// `storage` or `storage,downloads`. Empty (the default) enforces everything.
//
// This exists because relaxing a limit is a business decision that gets reversed,
// and the two obvious alternatives are both worse:
//
//   - Setting plan_features.value to -1 leaves no trace that anything was
//     deliberately suspended, loses the original numbers, and makes the plan card
//     ("100 MB storage") contradict the API ("unlimited").
//   - A row in app_settings would put a revenue-affecting switch one stray click
//     away in the admin panel, and nothing else in app_settings changes behaviour.
//
// An env var is deployment configuration, is announced in the boot log, and takes
// a deliberate restart to change in either direction.
//
// **Usage is still RECORDED while a feature is relaxed** — only the limit stops
// being applied. That is the same split the free tier already uses, and it means
// re-enabling enforcement needs no backfill: the counters and the upload ledger
// have kept running the whole time.
//
// Read from process.env on each call rather than captured at require time, so a
// test can flip it. The parse is memoised on the raw string, so the hot path is a
// string compare and a Set lookup.
let cachedRaw = null;
let cachedSet = new Set();

function relaxedFeatures() {
  const raw = process.env.QUOTA_RELAXED_FEATURES || '';
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSet = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return cachedSet;
}

const isRelaxed = (featureKey) => relaxedFeatures().has(featureKey);

module.exports = { relaxedFeatures, isRelaxed };
