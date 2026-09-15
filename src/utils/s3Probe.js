const s3 = require('./s3Helper');

// Cap on in-flight HEAD requests. The CSV importer and the asset file audit both
// check every distinct key up front, and a sheet or a table can hold thousands.
const S3_CONCURRENCY = 15;

// Run `fn` over the items with a capped number of in-flight S3 calls.
async function eachLimited(items, fn, concurrency = S3_CONCURRENCY) {
  const pending = [...items];
  const worker = async () => {
    for (let it = pending.shift(); it !== undefined; it = pending.shift()) await fn(it);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
}

// HEAD every distinct key. A null probe means "could not check" (see
// s3Helper.objectExists — no bucket configured, or an error other than 404) and
// is left OUT of `probes`, with `unavailable` set so the caller can decide whether
// an inconclusive check is a note or a hard stop. Only an explicit
// `{ exists: false }` ever means the object is gone.
async function probeKeys(keys) {
  const probes = new Map();
  let unavailable = false;
  await eachLimited(keys, async (k) => {
    const r = await s3.objectExists(k);
    if (r === null) unavailable = true;
    else probes.set(k, r);
  });
  return { probes, unavailable };
}

module.exports = { eachLimited, probeKeys, S3_CONCURRENCY };
